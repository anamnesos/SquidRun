'use strict';

const crypto = require('crypto');

const RUNTIME_DRY_RUN_IMPLEMENTATION_REPORT_SCHEMA_VERSION = 'squidrun.mira_core.runtime_dry_run_implementation_report.v0';
const VALIDATION_REPORT_SCHEMA_VERSION = 'squidrun.mira_core.runtime_dry_run_implementation_validation_report.v0';
const RUNTIME_DRY_RUN_IMPLEMENTATION_VERSION = 'v0';
const BASELINE_COMMIT = 'd4aa1a5';
const PHASE28_COMMIT = 'd4aa1a5';
const SLICE_ID = 'runtime_slice_0_disabled_local_dry_run_implementation';

const REQUIRED_OUTPUT_FIELDS = Object.freeze([
  'runtime_dry_run_implementation_report',
  'validation_report',
]);

const REQUIRED_REPORT_FIELDS = Object.freeze([
  'schema',
  'version',
  'implementation_report_id',
  'idempotency_key',
  'generated_at',
  'profile',
  'sessionId',
  'deviceId',
  'baseline_commit',
  'phase_28_dependency',
  'slice_id',
  'slice_status',
  'implementation_decision',
  'implementation_decision_allowed_values',
  'eligible_is_authorization',
  'eligible_is_runtime_proof',
  'runtime_available_now',
  'runtime_started',
  'runtime_mode_flag',
  'kill_switch',
  'dry_run_path',
  'local_binding',
  'telemetry_audit_preview',
  'operator_status',
  'rollback_disable_plan',
  'reference_only_dependencies',
  'phase28_prerequisite_status',
  'proof_boundaries',
  'target_boundaries',
  'unsafe_action_policy',
  'blocked_side_effects',
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
  'phase28_dependency_result',
  'implementation_decision_result',
  'runtime_mode_flag_result',
  'kill_switch_result',
  'dry_run_path_result',
  'local_binding_result',
  'telemetry_audit_result',
  'operator_status_result',
  'rollback_disable_result',
  'reference_only_dependency_result',
  'phase28_prerequisite_result',
  'proof_boundary_result',
  'target_boundary_result',
  'unsafe_action_result',
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

const DEFAULT_DECISIONS = Object.freeze([
  'remain_disabled_dry_run_contract_only',
  'blocked',
  'eligible_for_future_disabled_local_dry_run_validation_slice',
]);

const DEFAULT_PHASE28_PREREQUISITE_IDS = Object.freeze([
  'runtime-mode-flag-implementation',
  'live-kill-switch-wiring',
  'tested-dry-run-runtime-path',
  'actual-local-only-binding',
  'telemetry-audit-sink',
  'storage-env-config-key-auth-refs',
  'operator-ui-status-surface',
  'rollback-exercise',
  'end-to-end-runtime-proof',
]);

const DEFAULT_BLOCKED_SIDE_EFFECT_IDS = Object.freeze([
  'runtime',
  'server-listener-routes',
  'network',
  'db-store-file-migration',
  'queue-lease',
  'auth-key-secret-env',
  'local-execution-shell-pty-browser',
  'send-deploy-trade-customer-money',
  'output-file',
]);

const DEFAULT_NEXT_SAFE_ACTION_IDS = Object.freeze([
  'implement-phase29-validator-only',
  'review-phase29-before-any-runtime-enable-or-dry-run',
]);

const DEFAULT_TAMPER_CASE_IDS = Object.freeze([
  'tamper-stale-baseline',
  'tamper-stale-phase28-dependency',
  'tamper-eligible-as-authorization',
  'tamper-default-on-runtime-flag',
  'tamper-missing-kill-switch',
  'tamper-dry-run-executes-work',
  'tamper-non-loopback-binding',
  'tamper-telemetry-write',
  'tamper-raw-secret-path-leak',
  'tamper-unsafe-action-drift',
  'tamper-fake-proof',
  'tamper-direct-builder-oracle-target',
  'tamper-missing-phase28-gate',
  'tamper-prerequisite-satisfied-now',
  'tamper-side-effect-lie',
]);

const DEFAULT_FORBIDDEN_OUTPUT_SUBSTRINGS = Object.freeze([
  'runtime authorized',
  'runtime available now',
  'runtime started',
  'live runtime',
  'implementation authorizes runtime',
  'eligible authorizes runtime',
  'eligible proves runtime',
  'server started',
  'listener bound',
  'route registered',
  'http server listening',
  'websocket listening',
  'network request performed',
  'public interface allowed',
  'remote interface allowed',
  '0.0.0.0',
  'port opened',
  'port bound',
  'database write performed',
  'store write performed',
  'file write performed',
  'migration executed',
  'queue created',
  'lease created',
  'auth changed',
  'key generated',
  'secret read',
  'env secret read',
  'raw path',
  'local execution performed',
  'shell executed',
  'pty executed',
  'browser state captured',
  'screenshot captured',
  'ocr captured',
  'memory committed',
  'profile committed',
  'customer send performed',
  'customer email sent',
  'client message sent',
  'external send performed',
  'deploy performed',
  'trade performed',
  'money moved',
  'output file written',
  'runtime flag proves runtime',
  'kill switch proves runtime',
  'dry run response proves execution',
  'socket proves bridge green',
  'delivery acceptance proves model processing',
  'server can execute local arms',
  'direct builder target allowed',
  'direct oracle target allowed',
  'kill switch ignored',
  'dry run bypassed',
  'telemetry written',
  'audit written',
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

function evidenceRef(store, eventId, relation = 'runtime_dry_run_implementation_validation') {
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

function implementationExpected(contract = {}) {
  return contract.expectedRuntimeDryRunImplementationReportShape || {};
}

function decisionValues(contract = {}) {
  return asArray(implementationExpected(contract).implementationDecisionAllowedValues).length > 0
    ? implementationExpected(contract).implementationDecisionAllowedValues
    : DEFAULT_DECISIONS;
}

function prerequisiteIds(contract = {}) {
  return asArray(implementationExpected(contract).phase28PrerequisiteRequiredIds).length > 0
    ? implementationExpected(contract).phase28PrerequisiteRequiredIds
    : DEFAULT_PHASE28_PREREQUISITE_IDS;
}

function blockedSideEffectIds(contract = {}) {
  return asArray(implementationExpected(contract).blockedSideEffectRequiredIds).length > 0
    ? implementationExpected(contract).blockedSideEffectRequiredIds
    : DEFAULT_BLOCKED_SIDE_EFFECT_IDS;
}

function nextSafeActionIds(contract = {}) {
  return asArray(implementationExpected(contract).nextSafeActionRequiredIds).length > 0
    ? implementationExpected(contract).nextSafeActionRequiredIds
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

function phase28Dependency() {
  return {
    phase: 'phase_28_local_dry_run_preflight_review',
    commit: PHASE28_COMMIT,
    fixture_path: 'ui/__tests__/fixtures/mira-core-runtime-dry-run-review-contract.json',
    module_path: 'ui/modules/mira-core/runtime-dry-run-review.js',
    cli_path: 'ui/scripts/hm-mira-core-runtime-dry-run-review.js',
    test_path: 'ui/__tests__/mira-core-runtime-dry-run-review.test.js',
    status: 'committed_validation_only',
    default_decision: 'remain_pre_runtime_review',
    eligible_state: 'eligible_for_phase29_disabled_local_dry_run_implementation',
    eligible_is_authorization: false,
    eligible_is_runtime_proof: false,
    phase29_prerequisite_count: 9,
    evidenceRefs: [
      evidenceRef('git', PHASE28_COMMIT, 'phase28_commit'),
      evidenceRef('mira-core-runtime-dry-run-review', 'phase28-review'),
    ],
  };
}

function runtimeModeFlag() {
  return {
    flag_id: 'MIRA_CORE_RUNTIME_DRY_RUN_MODE',
    default_state: 'disabled',
    default_enabled: false,
    dev_only: true,
    local_only: true,
    operator_visible: true,
    non_authorizing: true,
    invalid_value_behavior: 'fail_closed_to_status_preview',
    runtime_started_when_present: false,
    evidenceRefs: [
      evidenceRef('mira-core-runtime-dry-run-implementation', 'runtime-mode-flag'),
    ],
  };
}

function killSwitch() {
  return {
    required: true,
    default_state: 'engaged',
    visible: true,
    fail_closed: true,
    testable: true,
    ignored_allowed: false,
    side_effect_on_toggle: false,
    evidenceRefs: [
      evidenceRef('mira-core-runtime-dry-run-implementation', 'kill-switch'),
    ],
  };
}

function dryRunPath() {
  return {
    path_type: 'in_process_status_preview_only',
    request_shape_ref: 'phase29:dry-run-request-shape',
    response_shape_ref: 'phase29:dry-run-response-shape',
    deterministic: true,
    idempotent: true,
    preview_only: true,
    executes_local_work: false,
    creates_queue_or_lease: false,
    writes_store_or_file: false,
    evidenceRefs: [
      evidenceRef('mira-core-runtime-dry-run-implementation', 'dry-run-path'),
    ],
  };
}

function localBinding() {
  return {
    binding_mode: 'in_process_or_loopback_only',
    allowed_hosts: [
      '127.0.0.1',
      '::1',
      'localhost',
    ],
    loopback_only: true,
    public_interface_allowed: false,
    remote_interface_allowed: false,
    listener_opened_now: false,
    network_performed_now: false,
    no_listener_unless_separately_gated: true,
    evidenceRefs: [
      evidenceRef('mira-core-runtime-dry-run-implementation', 'local-binding'),
    ],
  };
}

function telemetryAuditPreview() {
  return {
    redacted_preview_only: true,
    raw_payload_allowed: false,
    sink_reference_only: true,
    store_write_now: false,
    file_write_now: false,
    db_write_now: false,
    audit_event_shape_ref: 'phase29:redacted-audit-preview-shape',
    evidenceRefs: [
      evidenceRef('mira-core-runtime-dry-run-implementation', 'telemetry-audit-preview'),
    ],
  };
}

function operatorStatus() {
  return {
    visible: true,
    status_only: true,
    authorizes_runtime: false,
    fields: [
      'mode',
      'kill_switch',
      'boundary',
      'decision',
      'proof',
    ],
    evidenceRefs: [
      evidenceRef('mira-core-runtime-dry-run-implementation', 'operator-status'),
    ],
  };
}

function rollbackDisablePlan() {
  return {
    disable_idempotent: true,
    deletes_data: false,
    resurrects_blocked_state: false,
    rollback_executed_now: false,
    evidenceRefs: [
      evidenceRef('mira-core-runtime-dry-run-implementation', 'rollback-disable-plan'),
    ],
  };
}

function referenceNode(refId) {
  return {
    ref_id: refId,
    reference_only: true,
    material_exported: false,
  };
}

function referenceOnlyDependencies() {
  return {
    config_ref: referenceNode('phase29:config-reference'),
    auth_ref: referenceNode('phase29:auth-reference'),
    key_ref: referenceNode('phase29:key-reference'),
    storage_ref: referenceNode('phase29:storage-reference'),
    raw_path_allowed: false,
    raw_secret_allowed: false,
    env_secret_read: false,
    evidenceRefs: [
      evidenceRef('mira-core-runtime-dry-run-implementation', 'reference-only-dependencies'),
    ],
  };
}

function phase28PrerequisiteStatus(contract = {}) {
  return prerequisiteIds(contract).map((prerequisiteId) => ({
    prerequisite_id: prerequisiteId,
    phase29_contract_gate: `${prerequisiteId}:future-validation-gate`,
    status: 'defined_for_future_validation',
    satisfies_phase28_now: false,
    authorizes_runtime: false,
    requires_builder_implementation_test: true,
    evidenceRefs: [
      evidenceRef('mira-core-runtime-dry-run-implementation', `phase28-prerequisite:${prerequisiteId}`),
    ],
  }));
}

function proofBoundaries() {
  return {
    runtime_mode_flag_is_runtime_proof: false,
    kill_switch_wired_is_runtime_proof: false,
    dry_run_response_is_live_execution_proof: false,
    socket_is_bridge_green_proof: false,
    delivery_acceptance_is_model_processing_proof: false,
    serverCanExecuteLocal: false,
    server_can_execute_local_arms: false,
    evidenceRefs: [
      evidenceRef('mira-core-runtime-dry-run-implementation', 'proof-boundaries'),
    ],
  };
}

function targetBoundaries() {
  return {
    allowed_server_originated_target: 'architect',
    builder_direct_server_target_allowed: false,
    oracle_direct_server_target_allowed: false,
    local_architect_acceptance_required: true,
    evidenceRefs: [
      evidenceRef('mira-core-runtime-dry-run-implementation', 'target-boundaries'),
    ],
  };
}

function unsafeActionPolicy() {
  return {
    tier2_plus_blocked: true,
    outbound_customer_or_client_blocked: true,
    deploy_trade_money_blocked: true,
    external_send_blocked: true,
    capture_or_memory_commit_blocked: true,
    local_execution_blocked: true,
    evidenceRefs: [
      evidenceRef('mira-core-runtime-dry-run-implementation', 'unsafe-action-policy'),
    ],
  };
}

function blockedSideEffects(contract = {}) {
  return blockedSideEffectIds(contract).map((effectId) => ({
    effect_id: effectId,
    blocked_now: true,
    attempts: 0,
    evidenceRefs: [
      evidenceRef('mira-core-runtime-dry-run-implementation', `blocked-effect:${effectId}`),
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
      evidenceRef('mira-core-runtime-dry-run-implementation-tests', caseId),
    ],
  }));
}

function nextSafeActions(contract = {}) {
  const titles = {
    'implement-phase29-validator-only': 'Finish the Phase 29 validator',
    'review-phase29-before-any-runtime-enable-or-dry-run': 'Review Phase 29 before later work',
  };
  const reasons = {
    'implement-phase29-validator-only': 'This only checks disabled dry-run contract metadata.',
    'review-phase29-before-any-runtime-enable-or-dry-run': 'This keeps later work behind review and boundary checks.',
  };
  return nextSafeActionIds(contract).map((actionId) => ({
    action_id: actionId,
    title: titles[actionId] || actionId.replace(/-/g, ' '),
    risk_tier: 'tier0_read_only',
    allowed: true,
    why_safe: reasons[actionId] || 'This is read-only validation metadata.',
    evidenceRefs: [
      evidenceRef('mira-core-runtime-dry-run-implementation', `next-safe-action:${actionId}`),
    ],
  }));
}

function canonicalImplementationReportInput(report) {
  return {
    baseline_commit: report.baseline_commit,
    profile: report.profile,
    sessionId: report.sessionId,
    deviceId: report.deviceId,
    phase_28_dependency: report.phase_28_dependency,
    slice_id: report.slice_id,
    slice_status: report.slice_status,
    implementation_decision: report.implementation_decision,
    implementation_decision_allowed_values: report.implementation_decision_allowed_values,
    eligible_is_authorization: report.eligible_is_authorization,
    eligible_is_runtime_proof: report.eligible_is_runtime_proof,
    runtime_available_now: report.runtime_available_now,
    runtime_started: report.runtime_started,
    runtime_mode_flag: report.runtime_mode_flag,
    kill_switch: report.kill_switch,
    dry_run_path: report.dry_run_path,
    local_binding: report.local_binding,
    telemetry_audit_preview: report.telemetry_audit_preview,
    operator_status: report.operator_status,
    rollback_disable_plan: report.rollback_disable_plan,
    reference_only_dependencies: report.reference_only_dependencies,
    phase28_prerequisite_status: report.phase28_prerequisite_status,
    proof_boundaries: report.proof_boundaries,
    target_boundaries: report.target_boundaries,
    unsafe_action_policy: report.unsafe_action_policy,
    blocked_side_effects: report.blocked_side_effects,
    tamper_case_coverage: report.tamper_case_coverage,
    next_safe_actions: report.next_safe_actions,
    side_effect_result: report.side_effect_result,
  };
}

function runtimeDryRunImplementationIdempotencyKey(report) {
  return `runtime-dry-run-implementation:${stableHash(canonicalImplementationReportInput(report))}`;
}

function buildImplementationReport(options = {}) {
  const contract = options.contract || {};
  const inputSignals = options.inputSignals || {};
  const scope = normalizeScope(inputSignals);
  const generatedAt = generatedAtFromOptions(options, inputSignals);
  const allowed = decisionValues(contract);
  const requestedDecision = inputSignals.implementationDecision;
  const implementationDecision = allowed.includes(requestedDecision)
    ? requestedDecision
    : (implementationExpected(contract).requiredDefaultDecision || 'remain_disabled_dry_run_contract_only');
  const report = {
    schema: RUNTIME_DRY_RUN_IMPLEMENTATION_REPORT_SCHEMA_VERSION,
    version: RUNTIME_DRY_RUN_IMPLEMENTATION_VERSION,
    implementation_report_id: null,
    idempotency_key: null,
    generated_at: generatedAt,
    profile: scope.profile,
    sessionId: scope.sessionId,
    deviceId: scope.deviceId,
    baseline_commit: BASELINE_COMMIT,
    phase_28_dependency: phase28Dependency(),
    slice_id: SLICE_ID,
    slice_status: 'contract_ready_validation_only',
    implementation_decision: implementationDecision,
    implementation_decision_allowed_values: allowed,
    eligible_is_authorization: false,
    eligible_is_runtime_proof: false,
    runtime_available_now: false,
    runtime_started: false,
    runtime_mode_flag: runtimeModeFlag(),
    kill_switch: killSwitch(),
    dry_run_path: dryRunPath(),
    local_binding: localBinding(),
    telemetry_audit_preview: telemetryAuditPreview(),
    operator_status: operatorStatus(),
    rollback_disable_plan: rollbackDisablePlan(),
    reference_only_dependencies: referenceOnlyDependencies(),
    phase28_prerequisite_status: phase28PrerequisiteStatus(contract),
    proof_boundaries: proofBoundaries(),
    target_boundaries: targetBoundaries(),
    unsafe_action_policy: unsafeActionPolicy(),
    blocked_side_effects: blockedSideEffects(contract),
    tamper_case_coverage: tamperCaseCoverage(contract),
    next_safe_actions: nextSafeActions(contract),
    evidenceRefs: [
      evidenceRef('mira-core-runtime-dry-run-implementation', 'phase29-implementation-report'),
      evidenceRef('git', BASELINE_COMMIT, 'phase29_baseline_commit'),
    ],
    side_effect_result: sideEffectResult(),
  };
  report.idempotency_key = runtimeDryRunImplementationIdempotencyKey(report);
  report.implementation_report_id = `runtime-dry-run-implementation-${stableHash(report.idempotency_key).slice(0, 12)}`;
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

function phase28DependencyOk(report, contract = {}) {
  const dependency = report.phase_28_dependency || {};
  const expected = implementationExpected(contract);
  return hasRequiredFields(dependency, expected.phase28DependencyRequiredFields || [])
    && Object.entries(expected.phase28DependencyRequiredValues || {}).every(([field, value]) => valuesMatch(dependency[field], value))
    && dependency.fixture_path === 'ui/__tests__/fixtures/mira-core-runtime-dry-run-review-contract.json'
    && dependency.module_path === 'ui/modules/mira-core/runtime-dry-run-review.js'
    && dependency.cli_path === 'ui/scripts/hm-mira-core-runtime-dry-run-review.js'
    && dependency.test_path === 'ui/__tests__/mira-core-runtime-dry-run-review.test.js'
    && dependency.commit === PHASE28_COMMIT
    && dependency.status === 'committed_validation_only'
    && dependency.default_decision === 'remain_pre_runtime_review'
    && dependency.eligible_is_authorization === false
    && dependency.eligible_is_runtime_proof === false
    && dependency.phase29_prerequisite_count === 9
    && asArray(dependency.evidenceRefs).length > 0;
}

function implementationDecisionOk(report, contract = {}) {
  const allowed = decisionValues(contract);
  const eligibleSafe = report.implementation_decision !== 'eligible_for_future_disabled_local_dry_run_validation_slice'
    || (report.eligible_is_authorization === false
      && report.eligible_is_runtime_proof === false
      && report.runtime_available_now === false
      && report.runtime_started === false
      && sideEffectValuesOk(report.side_effect_result));
  return valuesMatch(report.implementation_decision_allowed_values, allowed)
    && allowed.includes(report.implementation_decision)
    && report.eligible_is_authorization === false
    && report.eligible_is_runtime_proof === false
    && report.runtime_available_now === false
    && report.runtime_started === false
    && eligibleSafe;
}

function defaultDecisionOk(report, contract = {}) {
  return report.implementation_decision === (implementationExpected(contract).requiredDefaultDecision || 'remain_disabled_dry_run_contract_only')
    && report.eligible_is_authorization === false
    && report.eligible_is_runtime_proof === false
    && report.runtime_available_now === false
    && report.runtime_started === false;
}

function runtimeModeFlagOk(report, contract = {}) {
  const flag = report.runtime_mode_flag || {};
  const expected = implementationExpected(contract);
  return hasRequiredFields(flag, expected.runtimeModeFlagRequiredFields || [])
    && flag.flag_id === 'MIRA_CORE_RUNTIME_DRY_RUN_MODE'
    && flag.default_state === 'disabled'
    && flag.default_enabled === false
    && flag.dev_only === true
    && flag.local_only === true
    && flag.operator_visible === true
    && flag.non_authorizing === true
    && flag.invalid_value_behavior === 'fail_closed_to_status_preview'
    && flag.runtime_started_when_present === false
    && asArray(flag.evidenceRefs).length > 0;
}

function killSwitchOk(report, contract = {}) {
  const control = report.kill_switch || {};
  const expected = implementationExpected(contract);
  return hasRequiredFields(control, expected.killSwitchRequiredFields || [])
    && control.required === true
    && control.default_state === 'engaged'
    && control.visible === true
    && control.fail_closed === true
    && control.testable === true
    && control.ignored_allowed === false
    && control.side_effect_on_toggle === false
    && asArray(control.evidenceRefs).length > 0;
}

function dryRunPathOk(report, contract = {}) {
  const path = report.dry_run_path || {};
  const expected = implementationExpected(contract);
  return hasRequiredFields(path, expected.dryRunPathRequiredFields || [])
    && path.path_type === 'in_process_status_preview_only'
    && typeof path.request_shape_ref === 'string'
    && typeof path.response_shape_ref === 'string'
    && path.deterministic === true
    && path.idempotent === true
    && path.preview_only === true
    && path.executes_local_work === false
    && path.creates_queue_or_lease === false
    && path.writes_store_or_file === false
    && asArray(path.evidenceRefs).length > 0;
}

function localBindingOk(report, contract = {}) {
  const binding = report.local_binding || {};
  const expected = implementationExpected(contract);
  return hasRequiredFields(binding, expected.localBindingRequiredFields || [])
    && binding.binding_mode === 'in_process_or_loopback_only'
    && valuesMatch(binding.allowed_hosts, ['127.0.0.1', '::1', 'localhost'])
    && !asArray(binding.allowed_hosts).some((host) => ['0.0.0.0', '*', 'public_interface', 'remote_interface'].includes(host))
    && binding.loopback_only === true
    && binding.public_interface_allowed === false
    && binding.remote_interface_allowed === false
    && binding.listener_opened_now === false
    && binding.network_performed_now === false
    && binding.no_listener_unless_separately_gated === true
    && asArray(binding.evidenceRefs).length > 0;
}

function telemetryAuditOk(report, contract = {}) {
  const plan = report.telemetry_audit_preview || {};
  const expected = implementationExpected(contract);
  return hasRequiredFields(plan, expected.telemetryAuditPreviewRequiredFields || [])
    && plan.redacted_preview_only === true
    && plan.raw_payload_allowed === false
    && plan.sink_reference_only === true
    && plan.store_write_now === false
    && plan.file_write_now === false
    && plan.db_write_now === false
    && typeof plan.audit_event_shape_ref === 'string'
    && asArray(plan.evidenceRefs).length > 0;
}

function operatorStatusOk(report, contract = {}) {
  const status = report.operator_status || {};
  const expected = implementationExpected(contract);
  return hasRequiredFields(status, expected.operatorStatusRequiredFields || [])
    && status.visible === true
    && status.status_only === true
    && status.authorizes_runtime === false
    && asArray(status.fields).includes('mode')
    && asArray(status.fields).includes('kill_switch')
    && asArray(status.fields).includes('boundary')
    && asArray(status.evidenceRefs).length > 0;
}

function rollbackDisableOk(report, contract = {}) {
  const plan = report.rollback_disable_plan || {};
  const expected = implementationExpected(contract);
  return hasRequiredFields(plan, expected.rollbackDisablePlanRequiredFields || [])
    && plan.disable_idempotent === true
    && plan.deletes_data === false
    && plan.resurrects_blocked_state === false
    && plan.rollback_executed_now === false
    && asArray(plan.evidenceRefs).length > 0;
}

function referenceNodeOk(node) {
  return Boolean(node) && node.reference_only === true && node.material_exported === false;
}

function referenceOnlyDependencyOk(report, contract = {}) {
  const refs = report.reference_only_dependencies || {};
  const expected = implementationExpected(contract);
  return hasRequiredFields(refs, expected.referenceOnlyDependencyRequiredFields || [])
    && referenceNodeOk(refs.config_ref)
    && referenceNodeOk(refs.auth_ref)
    && referenceNodeOk(refs.key_ref)
    && referenceNodeOk(refs.storage_ref)
    && refs.raw_path_allowed === false
    && refs.raw_secret_allowed === false
    && refs.env_secret_read === false
    && asArray(refs.evidenceRefs).length > 0;
}

function phase28PrerequisiteOk(report, contract = {}) {
  const statuses = asArray(report.phase28_prerequisite_status);
  const ids = prerequisiteIds(contract);
  const expected = implementationExpected(contract);
  const values = expected.phase28PrerequisiteStatusRequiredValues || {};
  return statuses.length === ids.length
    && idsEqual(statuses, 'prerequisite_id', ids)
    && statuses.every((status) => hasRequiredFields(status, expected.phase28PrerequisiteStatusRequiredFields || [])
      && typeof status.phase29_contract_gate === 'string'
      && Object.entries(values).every(([field, value]) => valuesMatch(status[field], value))
      && asArray(status.evidenceRefs).length > 0);
}

function proofBoundaryOk(report, contract = {}) {
  const proof = report.proof_boundaries || {};
  const expected = implementationExpected(contract);
  return hasRequiredFields(proof, expected.proofBoundaryRequiredFields || [])
    && proof.runtime_mode_flag_is_runtime_proof === false
    && proof.kill_switch_wired_is_runtime_proof === false
    && proof.dry_run_response_is_live_execution_proof === false
    && proof.socket_is_bridge_green_proof === false
    && proof.delivery_acceptance_is_model_processing_proof === false
    && proof.serverCanExecuteLocal === false
    && proof.server_can_execute_local_arms === false
    && asArray(proof.evidenceRefs).length > 0;
}

function targetBoundaryOk(report, contract = {}) {
  const target = report.target_boundaries || {};
  const expected = implementationExpected(contract);
  return hasRequiredFields(target, expected.targetBoundaryRequiredFields || [])
    && target.allowed_server_originated_target === 'architect'
    && target.builder_direct_server_target_allowed === false
    && target.oracle_direct_server_target_allowed === false
    && target.local_architect_acceptance_required === true
    && asArray(target.evidenceRefs).length > 0;
}

function blockedSideEffectsOk(report, contract = {}) {
  const effects = asArray(report.blocked_side_effects);
  const ids = blockedSideEffectIds(contract);
  return effects.length === ids.length
    && idsEqual(effects, 'effect_id', ids)
    && effects.every((effect) => effect.blocked_now === true
      && Number(effect.attempts || 0) === 0
      && asArray(effect.evidenceRefs).length > 0)
    && sideEffectValuesOk(report.side_effect_result);
}

function tamperCoverageOk(report, contract = {}) {
  const fixtureCases = asArray(contract.tamperCases);
  const ids = fixtureCases.length > 0 ? fixtureCases.map((item) => item.id) : DEFAULT_TAMPER_CASE_IDS;
  const coverage = asArray(report.tamper_case_coverage);
  return coverage.length === ids.length
    && idsEqual(coverage, 'tamper_case_id', ids)
    && coverage.every((item) => item.covered === true && asArray(item.evidenceRefs).length > 0);
}

function nextSafeActionsOk(report, contract = {}) {
  const actions = asArray(report.next_safe_actions);
  const ids = nextSafeActionIds(contract);
  return actions.length === ids.length
    && idsEqual(actions, 'action_id', ids)
    && actions.every((action) => action.allowed === true
      && /^tier[01]_/.test(action.risk_tier)
      && typeof action.why_safe === 'string'
      && asArray(action.evidenceRefs).length > 0);
}

function unsafeActionPolicyOk(report) {
  const policy = report.unsafe_action_policy || {};
  return policy.tier2_plus_blocked === true
    && policy.outbound_customer_or_client_blocked === true
    && policy.deploy_trade_money_blocked === true
    && policy.external_send_blocked === true
    && policy.capture_or_memory_commit_blocked === true
    && policy.local_execution_blocked === true
    && asArray(policy.evidenceRefs).length > 0;
}

function unsafeActionDriftOk(report) {
  const unsafePattern = /\b(tier[234]|runtime authorized|deploy|trade|money|move money|external send|memory commit|profile commit|capture|local execution|shell|pty)\b/i;
  const outboundTerms = new Set(['send', 'sent', 'sending', 'email', 'message', 'messaging', 'contact', 'reply', 'outbound']);
  const recipientTerms = new Set(['customer', 'customers', 'client', 'clients', 'contact', 'contacts', 'recipient', 'recipients']);
  const hasOutboundRecipientIntent = (text) => {
    const tokens = String(text || '').toLowerCase().match(/[a-z0-9]+/g) || [];
    return tokens.some((token) => outboundTerms.has(token))
      && tokens.some((token) => recipientTerms.has(token));
  };
  return asArray(report.next_safe_actions).every((action) => (
    action.allowed === true
      && !unsafePattern.test(String(action.risk_tier || ''))
      && !unsafePattern.test(String(action.why_safe || ''))
      && !unsafePattern.test(String(action.title || ''))
      && !hasOutboundRecipientIntent(action.risk_tier)
      && !hasOutboundRecipientIntent(action.why_safe)
      && !hasOutboundRecipientIntent(action.title)
  ));
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
      throw new Error(`runtime_dry_run_implementation_forbidden_substring:${forbidden}`);
    }
  }
}

function validateImplementationReport(report = {}, contract = {}) {
  const checks = [];
  const errors = [];
  const resultById = {};
  const add = (id, ok, detail = null, extra = {}) => {
    const result = { id, ok: ok === true, detail, ...extra };
    checks.push(result);
    resultById[id] = result;
    if (!ok && detail) errors.push(detail);
  };
  const expected = implementationExpected(contract);

  const baselineOk = report.baseline_commit === BASELINE_COMMIT;
  const dependencyOk = phase28DependencyOk(report, contract);
  const decisionSafe = implementationDecisionOk(report, contract);
  const defaultDecisionSafe = defaultDecisionOk(report, contract);
  const flagSafe = runtimeModeFlagOk(report, contract);
  const killSwitchSafe = killSwitchOk(report, contract);
  const dryRunSafe = dryRunPathOk(report, contract);
  const bindingSafe = localBindingOk(report, contract);
  const telemetrySafe = telemetryAuditOk(report, contract);
  const operatorSafe = operatorStatusOk(report, contract);
  const rollbackSafe = rollbackDisableOk(report, contract);
  const referenceSafe = referenceOnlyDependencyOk(report, contract);
  const prerequisiteSafe = phase28PrerequisiteOk(report, contract);
  const proofSafe = proofBoundaryOk(report, contract);
  const targetSafe = targetBoundaryOk(report, contract);
  const effectsSafe = blockedSideEffectsOk(report, contract);
  const nextActionsSafe = nextSafeActionsOk(report, contract);
  const unsafeDriftSafe = unsafeActionPolicyOk(report) && unsafeActionDriftOk(report);

  add('output-shape-complete',
    report.schema === RUNTIME_DRY_RUN_IMPLEMENTATION_REPORT_SCHEMA_VERSION
      && hasRequiredFields(report, expected.requiredFields || REQUIRED_REPORT_FIELDS),
    'Runtime dry-run implementation report shape is incomplete.');
  add('baseline-d4aa1a5-pinned', baselineOk, 'Baseline commit must stay pinned.');
  add('baseline-d4aa1a5-current', baselineOk, 'Baseline commit is stale.');
  add('stale-baseline-rejected', baselineOk, 'Stale baseline was accepted.');
  add('phase28-dependency-d4aa1a5-pinned', dependencyOk, 'Phase 28 dependency is missing or stale.');
  add('phase28-dependency-current', dependencyOk, 'Phase 28 dependency is stale.');
  add('phase28-review-non-authorizing', dependencyOk, 'Phase 28 dependency became authorizing.');
  add('stale-phase28-dependency-rejected', dependencyOk, 'Stale Phase 28 dependency was accepted.');
  add('decision-default-remain-contract-only', defaultDecisionSafe, 'Default implementation decision changed.');
  add('decision-default-contract-only', defaultDecisionSafe, 'Default implementation decision is unsafe.');
  add('eligible-future-validation-slice-non-authorizing', decisionSafe, 'Eligible future validation state became authorizing.');
  add('eligible-future-validation-non-authorizing', decisionSafe, 'Eligible decision is unsafe.');
  add('eligible-as-authorization-rejected', decisionSafe, 'Eligible-as-authorization was accepted.');
  add('runtime-mode-flag-disabled-local-dev-visible', flagSafe, 'Runtime mode flag is unsafe.');
  add('runtime-mode-invalid-values-fail-closed', flagSafe, 'Invalid runtime mode behavior is unsafe.');
  add('default-on-runtime-flag-rejected', flagSafe, 'Default-on runtime flag was accepted.');
  add('kill-switch-live-gate-fail-closed', killSwitchSafe, 'Kill switch is unsafe.');
  add('kill-switch-visible-fail-closed-testable', killSwitchSafe, 'Kill switch is not fail-closed/testable.');
  add('missing-kill-switch-rejected', killSwitchSafe, 'Missing or ignored kill switch was accepted.');
  add('dry-run-path-in-process-preview-only', dryRunSafe, 'Dry-run path is unsafe.');
  add('dry-run-path-preview-only', dryRunSafe, 'Dry-run path is not preview-only.');
  add('dry-run-execution-overclaim-rejected', dryRunSafe, 'Dry-run execution overclaim was accepted.');
  add('local-binding-loopback-only-no-listener-now', bindingSafe, 'Local binding is unsafe.');
  add('local-binding-in-process-or-loopback-only', bindingSafe, 'Local binding is not loopback-only.');
  add('non-loopback-binding-rejected', bindingSafe, 'Non-loopback binding was accepted.');
  add('telemetry-audit-redacted-preview-only', telemetrySafe, 'Telemetry/audit preview is unsafe.');
  add('telemetry-write-or-raw-payload-rejected', telemetrySafe, 'Telemetry write/raw payload was accepted.');
  add('operator-status-visible-non-authorizing', operatorSafe, 'Operator status is unsafe.');
  add('operator-status-visible-status-only', operatorSafe, 'Operator status is not status-only.');
  add('rollback-disable-idempotent-no-delete-no-resurrection', rollbackSafe, 'Rollback/disable plan is unsafe.');
  add('rollback-disable-idempotent', rollbackSafe, 'Rollback/disable is not idempotent.');
  add('config-auth-key-storage-refs-reference-only', referenceSafe, 'Reference dependencies are unsafe.');
  add('reference-only-dependencies-safe', referenceSafe, 'Reference dependencies leaked material.');
  add('raw-secret-path-leak-rejected', referenceSafe, 'Raw secret/path dependency was accepted.');
  add('phase28-prerequisites-carried-as-future-gates', prerequisiteSafe, 'Phase 28 prerequisites are incomplete.');
  add('phase28-prerequisite-gates-complete', prerequisiteSafe, 'Phase 28 prerequisite gates are incomplete.');
  add('phase28-prerequisites-not-satisfied-now', prerequisiteSafe, 'Phase 28 prerequisites were marked satisfied.');
  add('missing-phase28-prerequisite-gate-rejected', prerequisiteSafe, 'Missing Phase 28 gate was accepted.');
  add('phase28-prerequisite-satisfied-now-rejected', prerequisiteSafe, 'Satisfied/authorizing Phase 28 gate was accepted.');
  add('proof-boundaries-preserved', proofSafe, 'Proof boundaries were overclaimed.');
  add('fake-proof-rejected', proofSafe, 'Fake proof was accepted.');
  add('direct-builder-oracle-targets-blocked', targetSafe, 'Direct Builder/Oracle target was accepted.');
  add('unsafe-action-drift-rejected', nextActionsSafe && unsafeDriftSafe, 'Unsafe action drift was accepted.');
  add('side-effects-blocked-now', effectsSafe, 'Side-effect truth changed.');
  add('side-effect-truth-all-blocked', effectsSafe, 'Side-effect truth is unsafe.');

  try {
    assertNoForbiddenOutput(report, asArray(contract.forbiddenOutputSubstrings));
    add('forbidden-output-strings-absent', true, null);
  } catch (err) {
    add('forbidden-output-strings-absent', false, err.message);
  }

  add('tamper-coverage-complete', tamperCoverageOk(report, contract), 'Tamper coverage is incomplete.');
  add('idempotency-sensitive-to-dry-run-implementation-inputs',
    report.idempotency_key === runtimeDryRunImplementationIdempotencyKey(report),
    'Runtime dry-run implementation idempotency key is unstable.');
  add('idempotency-sensitive-to-implementation-inputs',
    report.idempotency_key === runtimeDryRunImplementationIdempotencyKey(report),
    'Runtime dry-run implementation idempotency did not reflect inputs.');
  add('report-literal-values',
    literalValuesOk(report, expected.requiredLiteralValues || {}),
    'Runtime dry-run implementation literal values changed.');

  return {
    ok: errors.length === 0,
    checks,
    errors,
    resultById,
  };
}

function buildValidationReport(implementationReport, contract = {}, generatedAt = implementationReport.generated_at) {
  const validation = validateImplementationReport(implementationReport, contract);
  const failed = validation.checks.filter((check) => !check.ok);
  const checkResult = (id) => validation.resultById[id] || resultObject(false, `${id} missing`);
  const report = {
    schema: VALIDATION_REPORT_SCHEMA_VERSION,
    version: RUNTIME_DRY_RUN_IMPLEMENTATION_VERSION,
    report_id: `runtime-dry-run-implementation-validation-${stableHash({
      implementation_key: implementationReport.idempotency_key,
      generatedAt,
    }).slice(0, 12)}`,
    generated_at: generatedAt,
    baseline_commit: BASELINE_COMMIT,
    decision: validation.ok ? 'accepted' : 'blocked',
    reasons: failed.map((check) => check.id),
    phase28_dependency_result: checkResult('phase28-dependency-current'),
    implementation_decision_result: checkResult('decision-default-contract-only'),
    runtime_mode_flag_result: checkResult('runtime-mode-flag-disabled-local-dev-visible'),
    kill_switch_result: checkResult('kill-switch-visible-fail-closed-testable'),
    dry_run_path_result: checkResult('dry-run-path-preview-only'),
    local_binding_result: checkResult('local-binding-in-process-or-loopback-only'),
    telemetry_audit_result: checkResult('telemetry-audit-redacted-preview-only'),
    operator_status_result: checkResult('operator-status-visible-status-only'),
    rollback_disable_result: checkResult('rollback-disable-idempotent'),
    reference_only_dependency_result: checkResult('reference-only-dependencies-safe'),
    phase28_prerequisite_result: checkResult('phase28-prerequisite-gates-complete'),
    proof_boundary_result: checkResult('proof-boundaries-preserved'),
    target_boundary_result: checkResult('direct-builder-oracle-targets-blocked'),
    unsafe_action_result: checkResult('unsafe-action-drift-rejected'),
    side_effect_result: sideEffectResult(),
    acceptance_checks: asArray(contract.acceptanceChecks).map((check) => ({
      id: check.id,
      ok: Boolean(validation.resultById[check.id]?.ok),
    })),
    failed_checks: failed.map((check) => check.id),
    evidenceRefs: [
      evidenceRef('mira-core-runtime-dry-run-implementation', 'phase29-validation-report'),
    ],
  };
  assertNoForbiddenOutput(report, asArray(contract.forbiddenOutputSubstrings));
  return report;
}

function buildMiraCoreRuntimeDryRunImplementation(options = {}) {
  const contract = options.contract || {};
  const implementationReport = buildImplementationReport(options);
  const validation_report = buildValidationReport(implementationReport, contract, implementationReport.generated_at);
  const output = {
    runtime_dry_run_implementation_report: implementationReport,
    validation_report,
  };
  assertNoForbiddenOutput(output, asArray(contract.forbiddenOutputSubstrings));
  return output;
}

function validateMiraCoreRuntimeDryRunImplementationOutput(output = {}, contract = {}) {
  const checks = [];
  const errors = [];
  const add = (id, ok, detail = null) => {
    checks.push({ id, ok: ok === true, detail });
    if (!ok && detail) errors.push(detail);
  };
  const implementationReport = output.runtime_dry_run_implementation_report || {};
  const validationReport = output.validation_report || {};
  const implementationValidation = validateImplementationReport(implementationReport, contract);
  const acceptanceIds = asArray(contract.acceptanceChecks).map((check) => check.id);

  add('output-shape-complete',
    hasRequiredFields(output, contract.expectedOutputShape?.requiredTopLevelFields || REQUIRED_OUTPUT_FIELDS)
      && implementationReport.schema === RUNTIME_DRY_RUN_IMPLEMENTATION_REPORT_SCHEMA_VERSION
      && validationReport.schema === VALIDATION_REPORT_SCHEMA_VERSION
      && hasRequiredFields(implementationReport, contract.expectedRuntimeDryRunImplementationReportShape?.requiredFields || REQUIRED_REPORT_FIELDS)
      && hasRequiredFields(validationReport, contract.expectedValidationReportShape?.requiredFields || REQUIRED_VALIDATION_REPORT_FIELDS),
    'Runtime dry-run implementation output shape is incomplete.');

  for (const check of implementationValidation.checks) add(check.id, check.ok, check.detail);

  add('validation-report-literal-values',
    validationReport.schema === VALIDATION_REPORT_SCHEMA_VERSION
      && validationReport.baseline_commit === BASELINE_COMMIT
      && literalValuesOk(validationReport, contract.expectedValidationReportShape?.requiredLiteralValues || {}),
    'Validation report literal values changed.');

  add('validation-report-side-effect-truth',
    sideEffectValuesOk(validationReport.side_effect_result),
    'Validation report side-effect truth is unsafe.');

  add('validation-report-acceptance-ids',
    idsEqual(asArray(validationReport.acceptance_checks), 'id', acceptanceIds),
    'Validation report acceptance check IDs do not match fixture.');

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
  DEFAULT_BLOCKED_SIDE_EFFECT_IDS,
  DEFAULT_DECISIONS,
  DEFAULT_NEXT_SAFE_ACTION_IDS,
  DEFAULT_PHASE28_PREREQUISITE_IDS,
  DEFAULT_TAMPER_CASE_IDS,
  PHASE28_COMMIT,
  REQUIRED_OUTPUT_FIELDS,
  REQUIRED_REPORT_FIELDS,
  REQUIRED_SIDE_EFFECT_FIELDS,
  REQUIRED_VALIDATION_REPORT_FIELDS,
  RUNTIME_DRY_RUN_IMPLEMENTATION_REPORT_SCHEMA_VERSION,
  SLICE_ID,
  VALIDATION_REPORT_SCHEMA_VERSION,
  assertNoForbiddenOutput,
  buildMiraCoreRuntimeDryRunImplementation,
  runtimeDryRunImplementationIdempotencyKey,
  stableHash,
  validateMiraCoreRuntimeDryRunImplementationOutput,
};
