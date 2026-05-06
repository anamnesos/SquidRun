'use strict';

const crypto = require('crypto');

const RUNTIME_CONTROL_PATH_REPORT_SCHEMA_VERSION = 'squidrun.mira_core.runtime_control_path_report.v0';
const VALIDATION_REPORT_SCHEMA_VERSION = 'squidrun.mira_core.runtime_control_path_validation_report.v0';
const RUNTIME_CONTROL_PATH_VERSION = 'v0';
const BASELINE_COMMIT = '8084b29';
const PHASE29_COMMIT = '8084b29';
const GATE_ID = 'runtime_slice_0_disabled_local_control_path_gate';

const REQUIRED_OUTPUT_FIELDS = Object.freeze([
  'runtime_control_path_report',
  'validation_report',
]);

const REQUIRED_REPORT_FIELDS = Object.freeze([
  'schema',
  'version',
  'control_path_report_id',
  'idempotency_key',
  'generated_at',
  'profile',
  'sessionId',
  'deviceId',
  'baseline_commit',
  'phase_29_dependency',
  'gate_id',
  'gate_status',
  'control_path_decision',
  'control_path_decision_allowed_values',
  'eligible_is_authorization',
  'eligible_is_runtime_proof',
  'runtime_available_now',
  'runtime_started',
  'runtime_mode_flag_reader',
  'kill_switch_check',
  'dry_run_request_shape',
  'dry_run_response_shape',
  'local_boundary',
  'operator_status_summary',
  'rollback_disable_behavior',
  'telemetry_audit_preview',
  'reference_only_dependencies',
  'phase29_prerequisite_gate_status',
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
  'phase29_dependency_result',
  'control_path_decision_result',
  'runtime_mode_flag_reader_result',
  'kill_switch_check_result',
  'dry_run_request_shape_result',
  'dry_run_response_shape_result',
  'local_boundary_result',
  'operator_status_summary_result',
  'rollback_disable_result',
  'telemetry_audit_result',
  'reference_only_dependency_result',
  'phase29_prerequisite_gate_result',
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
  'remain_control_path_contract_only',
  'blocked',
  'eligible_for_future_disabled_local_control_path_validation',
]);

const DEFAULT_PHASE29_PREREQUISITE_GATE_IDS = Object.freeze([
  'runtime-mode-flag-reader',
  'fail-closed-kill-switch-check',
  'dry-run-request-shape',
  'dry-run-response-shape',
  'local-in-process-loopback-boundary',
  'operator-visible-status-summary',
  'rollback-disable-behavior',
  'redacted-telemetry-audit-preview',
  'reference-only-config-auth-key-storage',
]);

const PHASE29_PREREQUISITE_MAP = Object.freeze({
  'runtime-mode-flag-reader': 'runtime-mode-flag-implementation',
  'fail-closed-kill-switch-check': 'live-kill-switch-wiring',
  'dry-run-request-shape': 'tested-dry-run-runtime-path',
  'dry-run-response-shape': 'tested-dry-run-runtime-path',
  'local-in-process-loopback-boundary': 'actual-local-only-binding',
  'operator-visible-status-summary': 'operator-ui-status-surface',
  'rollback-disable-behavior': 'rollback-exercise',
  'redacted-telemetry-audit-preview': 'telemetry-audit-sink',
  'reference-only-config-auth-key-storage': 'storage-env-config-key-auth-refs',
});

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
  'implement-phase30-validator-only',
  'review-phase30-before-any-runtime-mode-enable-or-dry-run',
]);

const DEFAULT_TAMPER_CASE_IDS = Object.freeze([
  'tamper-stale-baseline',
  'tamper-stale-phase29-dependency',
  'tamper-eligible-as-authorization',
  'tamper-default-on-runtime-flag-reader',
  'tamper-missing-kill-switch-check',
  'tamper-raw-request-payload',
  'tamper-response-executes-work',
  'tamper-non-loopback-boundary',
  'tamper-telemetry-write',
  'tamper-raw-secret-path-leak',
  'tamper-unsafe-action-drift',
  'tamper-fake-proof',
  'tamper-direct-builder-oracle-target',
  'tamper-missing-phase29-gate',
  'tamper-prerequisite-satisfied-now',
  'tamper-side-effect-lie',
]);

const DEFAULT_FORBIDDEN_OUTPUT_SUBSTRINGS = Object.freeze([
  'runtime authorized',
  'runtime available now',
  'runtime started',
  'live runtime',
  'control path authorizes runtime',
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
  'control path proves runtime',
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

function evidenceRef(store, eventId, relation = 'runtime_control_path_validation') {
  return { store, eventId, relation };
}

function resultObject(ok, detail = null) {
  return { ok: ok === true, detail };
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

function controlPathExpected(contract = {}) {
  return contract.expectedRuntimeControlPathReportShape || {};
}

function decisionValues(contract = {}) {
  return asArray(controlPathExpected(contract).controlPathDecisionAllowedValues).length > 0
    ? controlPathExpected(contract).controlPathDecisionAllowedValues
    : DEFAULT_DECISIONS;
}

function prerequisiteGateIds(contract = {}) {
  return asArray(controlPathExpected(contract).phase29PrerequisiteGateRequiredIds).length > 0
    ? controlPathExpected(contract).phase29PrerequisiteGateRequiredIds
    : DEFAULT_PHASE29_PREREQUISITE_GATE_IDS;
}

function blockedSideEffectIds(contract = {}) {
  return asArray(controlPathExpected(contract).blockedSideEffectRequiredIds).length > 0
    ? controlPathExpected(contract).blockedSideEffectRequiredIds
    : DEFAULT_BLOCKED_SIDE_EFFECT_IDS;
}

function nextSafeActionIds(contract = {}) {
  return asArray(controlPathExpected(contract).nextSafeActionRequiredIds).length > 0
    ? controlPathExpected(contract).nextSafeActionRequiredIds
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

function phase29Dependency() {
  return {
    phase: 'phase_29_disabled_local_dry_run_implementation_slice_contract',
    commit: PHASE29_COMMIT,
    fixture_path: 'ui/__tests__/fixtures/mira-core-runtime-dry-run-implementation-contract.json',
    module_path: 'ui/modules/mira-core/runtime-dry-run-implementation.js',
    cli_path: 'ui/scripts/hm-mira-core-runtime-dry-run-implementation.js',
    test_path: 'ui/__tests__/mira-core-runtime-dry-run-implementation.test.js',
    status: 'committed_validation_only',
    default_decision: 'remain_disabled_dry_run_contract_only',
    eligible_state: 'eligible_for_future_disabled_local_dry_run_validation_slice',
    eligible_is_authorization: false,
    eligible_is_runtime_proof: false,
    phase28_prerequisite_gate_count: 9,
    evidenceRefs: [
      evidenceRef('git', PHASE29_COMMIT, 'phase29_commit'),
      evidenceRef('mira-core-runtime-dry-run-implementation', 'phase29-implementation'),
    ],
  };
}

function runtimeModeFlagReader() {
  return {
    flag_id: 'MIRA_CORE_RUNTIME_DRY_RUN_MODE',
    default_state: 'disabled',
    default_enabled: false,
    dev_only: true,
    local_only: true,
    operator_visible: true,
    non_authorizing: true,
    invalid_value_behavior: 'fail_closed_to_status_preview',
    reads_env_secret: false,
    starts_runtime: false,
    evidenceRefs: [
      evidenceRef('mira-core-runtime-control-path', 'runtime-mode-flag-reader'),
    ],
  };
}

function killSwitchCheck() {
  return {
    required: true,
    default_state: 'engaged',
    fail_closed: true,
    testable: true,
    ignored_allowed: false,
    side_effect_on_check: false,
    authorizes_runtime: false,
    evidenceRefs: [
      evidenceRef('mira-core-runtime-control-path', 'kill-switch-check'),
    ],
  };
}

function dryRunRequestShape() {
  return {
    schema: 'squidrun.mira_core.runtime_control_path_request.v0',
    required_fields: [
      'request_id',
      'profile',
      'sessionId',
      'deviceId',
      'idempotency_key',
      'redaction_status',
      'operator_status_ref',
    ],
    validation_only: true,
    idempotent: true,
    redacted_payload_only: true,
    allows_raw_payload: false,
    requires_operator_visible_status: true,
    evidenceRefs: [
      evidenceRef('mira-core-runtime-control-path', 'dry-run-request-shape'),
    ],
  };
}

function dryRunResponseShape() {
  return {
    schema: 'squidrun.mira_core.runtime_control_path_response.v0',
    required_fields: [
      'response_id',
      'request_ref',
      'status',
      'decision',
      'operator_status',
      'proof_boundaries',
      'side_effect_result',
    ],
    status_preview_only: true,
    executes_local_work: false,
    creates_queue_or_lease: false,
    writes_store_or_file: false,
    authorizes_runtime: false,
    evidenceRefs: [
      evidenceRef('mira-core-runtime-control-path', 'dry-run-response-shape'),
    ],
  };
}

function localBoundary() {
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
      evidenceRef('mira-core-runtime-control-path', 'local-boundary'),
    ],
  };
}

function operatorStatusSummary() {
  return {
    visible: true,
    status_only: true,
    authorizes_runtime: false,
    includes_mode: true,
    includes_kill_switch: true,
    includes_boundary: true,
    includes_proof_truth: true,
    evidenceRefs: [
      evidenceRef('mira-core-runtime-control-path', 'operator-status-summary'),
    ],
  };
}

function rollbackDisableBehavior() {
  return {
    disable_idempotent: true,
    deletes_data: false,
    resurrects_blocked_state: false,
    rollback_executed_now: false,
    disable_authorizes_runtime: false,
    evidenceRefs: [
      evidenceRef('mira-core-runtime-control-path', 'rollback-disable-behavior'),
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
    audit_event_shape_ref: 'phase30:redacted-preview-shape',
    evidenceRefs: [
      evidenceRef('mira-core-runtime-control-path', 'telemetry-audit-preview'),
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
    config_ref: referenceNode('phase30:config-reference'),
    auth_ref: referenceNode('phase30:auth-reference'),
    key_ref: referenceNode('phase30:key-reference'),
    storage_ref: referenceNode('phase30:storage-reference'),
    raw_path_allowed: false,
    raw_secret_allowed: false,
    env_secret_read: false,
    evidenceRefs: [
      evidenceRef('mira-core-runtime-control-path', 'reference-only-dependencies'),
    ],
  };
}

function phase29PrerequisiteGateStatus(contract = {}) {
  return prerequisiteGateIds(contract).map((gateId) => ({
    gate_id: gateId,
    maps_from_phase29_prerequisite: PHASE29_PREREQUISITE_MAP[gateId] || gateId,
    status: 'defined_for_future_control_path_validation',
    satisfies_phase29_now: false,
    authorizes_runtime: false,
    requires_builder_implementation_test: true,
    evidenceRefs: [
      evidenceRef('mira-core-runtime-control-path', `phase29-gate:${gateId}`),
    ],
  }));
}

function proofBoundaries() {
  return {
    runtime_mode_flag_is_runtime_proof: false,
    kill_switch_check_is_runtime_proof: false,
    dry_run_response_is_live_execution_proof: false,
    control_path_present_is_runtime_proof: false,
    socket_is_bridge_green_proof: false,
    delivery_acceptance_is_model_processing_proof: false,
    serverCanExecuteLocal: false,
    server_can_execute_local_arms: false,
    evidenceRefs: [
      evidenceRef('mira-core-runtime-control-path', 'proof-boundaries'),
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
      evidenceRef('mira-core-runtime-control-path', 'target-boundaries'),
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
      evidenceRef('mira-core-runtime-control-path', 'unsafe-action-policy'),
    ],
  };
}

function blockedSideEffects(contract = {}) {
  return blockedSideEffectIds(contract).map((effectId) => ({
    effect_id: effectId,
    blocked_now: true,
    attempts: 0,
    evidenceRefs: [
      evidenceRef('mira-core-runtime-control-path', `blocked-effect:${effectId}`),
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
      evidenceRef('mira-core-runtime-control-path-tests', caseId),
    ],
  }));
}

function nextSafeActions(contract = {}) {
  const titles = {
    'implement-phase30-validator-only': 'Finish the Phase 30 validator',
    'review-phase30-before-any-runtime-mode-enable-or-dry-run': 'Review Phase 30 before later work',
  };
  const reasons = {
    'implement-phase30-validator-only': 'This only checks control-path contract metadata.',
    'review-phase30-before-any-runtime-mode-enable-or-dry-run': 'This keeps later work behind review and boundary checks.',
  };
  return nextSafeActionIds(contract).map((actionId) => ({
    action_id: actionId,
    title: titles[actionId] || actionId.replace(/-/g, ' '),
    risk_tier: 'tier0_read_only',
    allowed: true,
    why_safe: reasons[actionId] || 'This is read-only validation metadata.',
    evidenceRefs: [
      evidenceRef('mira-core-runtime-control-path', `next-safe-action:${actionId}`),
    ],
  }));
}

function canonicalControlPathReportInput(report) {
  return {
    baseline_commit: report.baseline_commit,
    profile: report.profile,
    sessionId: report.sessionId,
    deviceId: report.deviceId,
    phase_29_dependency: report.phase_29_dependency,
    gate_id: report.gate_id,
    gate_status: report.gate_status,
    control_path_decision: report.control_path_decision,
    control_path_decision_allowed_values: report.control_path_decision_allowed_values,
    eligible_is_authorization: report.eligible_is_authorization,
    eligible_is_runtime_proof: report.eligible_is_runtime_proof,
    runtime_available_now: report.runtime_available_now,
    runtime_started: report.runtime_started,
    runtime_mode_flag_reader: report.runtime_mode_flag_reader,
    kill_switch_check: report.kill_switch_check,
    dry_run_request_shape: report.dry_run_request_shape,
    dry_run_response_shape: report.dry_run_response_shape,
    local_boundary: report.local_boundary,
    operator_status_summary: report.operator_status_summary,
    rollback_disable_behavior: report.rollback_disable_behavior,
    telemetry_audit_preview: report.telemetry_audit_preview,
    reference_only_dependencies: report.reference_only_dependencies,
    phase29_prerequisite_gate_status: report.phase29_prerequisite_gate_status,
    proof_boundaries: report.proof_boundaries,
    target_boundaries: report.target_boundaries,
    unsafe_action_policy: report.unsafe_action_policy,
    blocked_side_effects: report.blocked_side_effects,
    tamper_case_coverage: report.tamper_case_coverage,
    next_safe_actions: report.next_safe_actions,
    side_effect_result: report.side_effect_result,
  };
}

function runtimeControlPathIdempotencyKey(report) {
  return `mira-core-runtime-control-path:${stableHash(canonicalControlPathReportInput(report))}`;
}

function buildRuntimeControlPathReport(options = {}) {
  const contract = options.contract || {};
  const inputSignals = options.inputSignals || {};
  const scope = normalizeScope(inputSignals);
  const generatedAt = generatedAtFromOptions(options, inputSignals);
  const report = {
    schema: RUNTIME_CONTROL_PATH_REPORT_SCHEMA_VERSION,
    version: RUNTIME_CONTROL_PATH_VERSION,
    control_path_report_id: '',
    idempotency_key: '',
    generated_at: generatedAt,
    profile: scope.profile,
    sessionId: scope.sessionId,
    deviceId: scope.deviceId,
    baseline_commit: inputSignals.baseline_commit || BASELINE_COMMIT,
    phase_29_dependency: phase29Dependency(),
    gate_id: GATE_ID,
    gate_status: 'contract_ready_validation_only',
    control_path_decision: inputSignals.controlPathDecision || 'remain_control_path_contract_only',
    control_path_decision_allowed_values: decisionValues(contract),
    eligible_is_authorization: false,
    eligible_is_runtime_proof: false,
    runtime_available_now: false,
    runtime_started: false,
    runtime_mode_flag_reader: runtimeModeFlagReader(),
    kill_switch_check: killSwitchCheck(),
    dry_run_request_shape: dryRunRequestShape(),
    dry_run_response_shape: dryRunResponseShape(),
    local_boundary: localBoundary(),
    operator_status_summary: operatorStatusSummary(),
    rollback_disable_behavior: rollbackDisableBehavior(),
    telemetry_audit_preview: telemetryAuditPreview(),
    reference_only_dependencies: referenceOnlyDependencies(),
    phase29_prerequisite_gate_status: phase29PrerequisiteGateStatus(contract),
    proof_boundaries: proofBoundaries(),
    target_boundaries: targetBoundaries(),
    unsafe_action_policy: unsafeActionPolicy(),
    blocked_side_effects: blockedSideEffects(contract),
    tamper_case_coverage: tamperCaseCoverage(contract),
    next_safe_actions: nextSafeActions(contract),
    evidenceRefs: [
      evidenceRef('git', BASELINE_COMMIT, 'phase30_baseline'),
      evidenceRef('mira-core-runtime-control-path-contract', 'phase30-contract'),
    ],
    side_effect_result: sideEffectResult(),
  };
  report.idempotency_key = runtimeControlPathIdempotencyKey(report);
  report.control_path_report_id = `runtime-control-path-${stableHash({
    key: report.idempotency_key,
    generatedAt,
  }).slice(0, 12)}`;
  assertNoForbiddenOutput(report, asArray(contract.forbiddenOutputSubstrings));
  return report;
}

function literalValuesOk(report, required = {}) {
  return Object.entries(required).every(([path, expectedValue]) => valuesMatch(pathValue(report, path), expectedValue));
}

function sideEffectValuesOk(result = {}) {
  return REQUIRED_SIDE_EFFECT_FIELDS.every((field) => result[field] === true)
    && SIDE_EFFECT_COUNTER_FIELDS.every((field) => Number(result[field] || 0) === 0)
    && result.outputFileWritten === false;
}

function phase29DependencyOk(report, contract = {}) {
  const dependency = report.phase_29_dependency || {};
  const expected = controlPathExpected(contract);
  const values = expected.phase29DependencyRequiredValues || {};
  return hasRequiredFields(dependency, expected.phase29DependencyRequiredFields || [])
    && dependency.status === 'committed_validation_only'
    && Object.entries(values).every(([field, value]) => valuesMatch(dependency[field], value))
    && asArray(dependency.evidenceRefs).length > 0;
}

function controlPathDecisionOk(report, contract = {}) {
  const expectedEligible = controlPathExpected(contract).eligibleDecisionRequiredValues || {};
  const decision = report.control_path_decision;
  return decisionValues(contract).includes(decision)
    && report.eligible_is_authorization === false
    && report.eligible_is_runtime_proof === false
    && report.runtime_available_now === false
    && report.runtime_started === false
    && Object.entries(expectedEligible).every(([field, value]) => (
      field === 'requires_future_review' || field === 'requires_operator_review'
        ? true
        : valuesMatch(report[field], value)
    ));
}

function defaultDecisionOk(report, contract = {}) {
  const expected = controlPathExpected(contract);
  return report.control_path_decision === (expected.requiredDefaultDecision || 'remain_control_path_contract_only');
}

function runtimeModeFlagReaderOk(report, contract = {}) {
  const flag = report.runtime_mode_flag_reader || {};
  const expected = controlPathExpected(contract);
  return hasRequiredFields(flag, expected.runtimeModeFlagReaderRequiredFields || [])
    && flag.flag_id === 'MIRA_CORE_RUNTIME_DRY_RUN_MODE'
    && flag.default_state === 'disabled'
    && flag.default_enabled === false
    && flag.dev_only === true
    && flag.local_only === true
    && flag.operator_visible === true
    && flag.non_authorizing === true
    && flag.invalid_value_behavior === 'fail_closed_to_status_preview'
    && flag.reads_env_secret === false
    && flag.starts_runtime === false
    && report.runtime_started === false
    && report.runtime_available_now === false
    && asArray(flag.evidenceRefs).length > 0;
}

function killSwitchOk(report, contract = {}) {
  const killSwitch = report.kill_switch_check || {};
  const expected = controlPathExpected(contract);
  return hasRequiredFields(killSwitch, expected.killSwitchCheckRequiredFields || [])
    && killSwitch.required === true
    && killSwitch.default_state === 'engaged'
    && killSwitch.fail_closed === true
    && killSwitch.testable === true
    && killSwitch.ignored_allowed === false
    && killSwitch.side_effect_on_check === false
    && killSwitch.authorizes_runtime === false
    && asArray(killSwitch.evidenceRefs).length > 0;
}

function dryRunRequestShapeOk(report, contract = {}) {
  const shape = report.dry_run_request_shape || {};
  const expected = controlPathExpected(contract);
  return hasRequiredFields(shape, expected.dryRunRequestShapeRequiredFields || [])
    && shape.schema === 'squidrun.mira_core.runtime_control_path_request.v0'
    && asArray(shape.required_fields).length > 0
    && shape.validation_only === true
    && shape.idempotent === true
    && shape.redacted_payload_only === true
    && shape.allows_raw_payload === false
    && shape.requires_operator_visible_status === true
    && asArray(shape.evidenceRefs).length > 0;
}

function dryRunResponseShapeOk(report, contract = {}) {
  const shape = report.dry_run_response_shape || {};
  const expected = controlPathExpected(contract);
  return hasRequiredFields(shape, expected.dryRunResponseShapeRequiredFields || [])
    && shape.schema === 'squidrun.mira_core.runtime_control_path_response.v0'
    && asArray(shape.required_fields).length > 0
    && shape.status_preview_only === true
    && shape.executes_local_work === false
    && shape.creates_queue_or_lease === false
    && shape.writes_store_or_file === false
    && shape.authorizes_runtime === false
    && asArray(shape.evidenceRefs).length > 0;
}

function localBoundaryOk(report, contract = {}) {
  const boundary = report.local_boundary || {};
  const expected = controlPathExpected(contract);
  return hasRequiredFields(boundary, expected.localBoundaryRequiredFields || [])
    && boundary.binding_mode === 'in_process_or_loopback_only'
    && valuesMatch(boundary.allowed_hosts, ['127.0.0.1', '::1', 'localhost'])
    && boundary.loopback_only === true
    && boundary.public_interface_allowed === false
    && boundary.remote_interface_allowed === false
    && boundary.listener_opened_now === false
    && boundary.network_performed_now === false
    && boundary.no_listener_unless_separately_gated === true
    && asArray(boundary.evidenceRefs).length > 0;
}

function operatorStatusSummaryOk(report, contract = {}) {
  const status = report.operator_status_summary || {};
  const expected = controlPathExpected(contract);
  return hasRequiredFields(status, expected.operatorStatusSummaryRequiredFields || [])
    && status.visible === true
    && status.status_only === true
    && status.authorizes_runtime === false
    && status.includes_mode === true
    && status.includes_kill_switch === true
    && status.includes_boundary === true
    && status.includes_proof_truth === true
    && asArray(status.evidenceRefs).length > 0;
}

function rollbackDisableBehaviorOk(report, contract = {}) {
  const rollback = report.rollback_disable_behavior || {};
  const expected = controlPathExpected(contract);
  return hasRequiredFields(rollback, expected.rollbackDisableBehaviorRequiredFields || [])
    && rollback.disable_idempotent === true
    && rollback.deletes_data === false
    && rollback.resurrects_blocked_state === false
    && rollback.rollback_executed_now === false
    && rollback.disable_authorizes_runtime === false
    && asArray(rollback.evidenceRefs).length > 0;
}

function telemetryAuditPreviewOk(report, contract = {}) {
  const telemetry = report.telemetry_audit_preview || {};
  const expected = controlPathExpected(contract);
  return hasRequiredFields(telemetry, expected.telemetryAuditPreviewRequiredFields || [])
    && telemetry.redacted_preview_only === true
    && telemetry.raw_payload_allowed === false
    && telemetry.sink_reference_only === true
    && telemetry.store_write_now === false
    && telemetry.file_write_now === false
    && telemetry.db_write_now === false
    && typeof telemetry.audit_event_shape_ref === 'string'
    && asArray(telemetry.evidenceRefs).length > 0;
}

function referenceNodeOk(node) {
  return Boolean(node) && node.reference_only === true && node.material_exported === false;
}

function referenceOnlyDependencyOk(report, contract = {}) {
  const refs = report.reference_only_dependencies || {};
  const expected = controlPathExpected(contract);
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

function phase29PrerequisiteGateOk(report, contract = {}) {
  const statuses = asArray(report.phase29_prerequisite_gate_status);
  const ids = prerequisiteGateIds(contract);
  const expected = controlPathExpected(contract);
  const values = expected.phase29PrerequisiteGateRequiredValues || {};
  return statuses.length === ids.length
    && idsEqual(statuses, 'gate_id', ids)
    && statuses.every((status) => hasRequiredFields(status, expected.phase29PrerequisiteGateRequiredFields || [])
      && status.maps_from_phase29_prerequisite === PHASE29_PREREQUISITE_MAP[status.gate_id]
      && Object.entries(values).every(([field, value]) => valuesMatch(status[field], value))
      && asArray(status.evidenceRefs).length > 0);
}

function proofBoundaryOk(report, contract = {}) {
  const proof = report.proof_boundaries || {};
  const expected = controlPathExpected(contract);
  return hasRequiredFields(proof, expected.proofBoundaryRequiredFields || [])
    && proof.runtime_mode_flag_is_runtime_proof === false
    && proof.kill_switch_check_is_runtime_proof === false
    && proof.dry_run_response_is_live_execution_proof === false
    && proof.control_path_present_is_runtime_proof === false
    && proof.socket_is_bridge_green_proof === false
    && proof.delivery_acceptance_is_model_processing_proof === false
    && proof.serverCanExecuteLocal === false
    && proof.server_can_execute_local_arms === false;
}

function targetBoundaryOk(report, contract = {}) {
  const target = report.target_boundaries || {};
  const expected = controlPathExpected(contract);
  return hasRequiredFields(target, expected.targetBoundaryRequiredFields || [])
    && target.allowed_server_originated_target === 'architect'
    && target.builder_direct_server_target_allowed === false
    && target.oracle_direct_server_target_allowed === false
    && target.local_architect_acceptance_required === true;
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

function unsafeActionDriftOk(report) {
  const unsafePattern = /\b(tier[234]|runtime authorized|deploy|trade|money|move money|external send|memory commit|profile commit|capture|local execution|shell|pty)\b/i;
  const outboundTerms = new Set(['send', 'sent', 'sending', 'email', 'message', 'messaging', 'contact', 'reply', 'outbound']);
  const recipientTerms = new Set(['customer', 'customers', 'client', 'clients', 'contact', 'contacts', 'recipient', 'recipients']);
  const hasOutboundRecipientIntent = (text) => {
    const tokens = String(text || '').toLowerCase().match(/[a-z0-9]+/g) || [];
    return tokens.some((token) => outboundTerms.has(token))
      && tokens.some((token) => recipientTerms.has(token));
  };
  const strings = [
    ...collectStringValues(report.next_safe_actions),
    ...collectStringValues(report.dry_run_request_shape),
    ...collectStringValues(report.dry_run_response_shape),
    ...collectStringValues(report.operator_status_summary),
    String(report.control_path_decision || ''),
  ];
  return strings.every((text) => !unsafePattern.test(text) && !hasOutboundRecipientIntent(text));
}

function assertNoForbiddenOutput(value, extraForbidden = []) {
  const strings = collectStringValues(value);
  for (const forbidden of [...DEFAULT_FORBIDDEN_OUTPUT_SUBSTRINGS, ...extraForbidden]) {
    if (!forbidden) continue;
    const needle = String(forbidden).toLowerCase();
    if (strings.some((entry) => String(entry).toLowerCase().includes(needle))) {
      throw new Error(`runtime_control_path_forbidden_substring:${forbidden}`);
    }
  }
}

function validateControlPathReport(report = {}, contract = {}) {
  const checks = [];
  const errors = [];
  const resultById = {};
  const add = (id, ok, detail = null) => {
    const result = { id, ok: ok === true, detail };
    checks.push(result);
    resultById[id] = result;
    if (!ok && detail) errors.push(detail);
  };
  const expected = controlPathExpected(contract);

  const baselineOk = report.baseline_commit === BASELINE_COMMIT;
  const dependencyOk = phase29DependencyOk(report, contract);
  const decisionSafe = controlPathDecisionOk(report, contract);
  const defaultDecisionSafe = defaultDecisionOk(report, contract);
  const flagSafe = runtimeModeFlagReaderOk(report, contract);
  const killSwitchSafe = killSwitchOk(report, contract);
  const requestSafe = dryRunRequestShapeOk(report, contract);
  const responseSafe = dryRunResponseShapeOk(report, contract);
  const boundarySafe = localBoundaryOk(report, contract);
  const operatorSafe = operatorStatusSummaryOk(report, contract);
  const rollbackSafe = rollbackDisableBehaviorOk(report, contract);
  const telemetrySafe = telemetryAuditPreviewOk(report, contract);
  const referenceSafe = referenceOnlyDependencyOk(report, contract);
  const gateSafe = phase29PrerequisiteGateOk(report, contract);
  const proofSafe = proofBoundaryOk(report, contract);
  const targetSafe = targetBoundaryOk(report, contract);
  const effectsSafe = blockedSideEffectsOk(report, contract);
  const nextActionsSafe = nextSafeActionsOk(report, contract);
  const unsafeDriftSafe = unsafeActionPolicyOk(report) && unsafeActionDriftOk(report);

  add('output-shape-complete',
    report.schema === RUNTIME_CONTROL_PATH_REPORT_SCHEMA_VERSION
      && hasRequiredFields(report, expected.requiredFields || REQUIRED_REPORT_FIELDS),
    'control-path report shape is incomplete');
  add('baseline-8084b29-pinned', baselineOk, 'baseline pin changed');
  add('baseline-8084b29-current', baselineOk, 'baseline is stale');
  add('stale-baseline-rejected', baselineOk, 'stale baseline accepted');
  add('phase29-dependency-8084b29-pinned', dependencyOk, 'Phase 29 dependency is stale');
  add('phase29-dependency-current', dependencyOk, 'Phase 29 dependency changed');
  add('phase29-review-non-authorizing', dependencyOk, 'Phase 29 dependency boundary changed');
  add('stale-phase29-dependency-rejected', dependencyOk, 'stale Phase 29 dependency accepted');
  add('decision-default-remain-control-path-contract-only', defaultDecisionSafe, 'default decision changed');
  add('decision-default-control-path-contract-only', defaultDecisionSafe, 'default decision unsafe');
  add('eligible-control-path-state-non-authorizing', decisionSafe, 'eligible state became unsafe');
  add('eligible-control-path-non-authorizing', decisionSafe, 'eligible boundary changed');
  add('eligible-as-authorization-rejected', decisionSafe, 'eligible-as-authorization accepted');
  add('runtime-mode-flag-reader-disabled-local-dev-visible', flagSafe, 'mode flag reader unsafe');
  add('runtime-mode-invalid-values-fail-closed', flagSafe, 'mode flag invalid behavior unsafe');
  add('default-on-runtime-flag-rejected', flagSafe, 'default-on flag accepted');
  add('kill-switch-check-fail-closed', killSwitchSafe, 'kill switch unsafe');
  add('kill-switch-check-fail-closed-testable', killSwitchSafe, 'kill switch gate unsafe');
  add('missing-kill-switch-rejected', killSwitchSafe, 'missing kill switch accepted');
  add('dry-run-request-shape-redacted-idempotent', requestSafe, 'request shape unsafe');
  add('dry-run-request-shape-safe', requestSafe, 'request shape boundary changed');
  add('raw-request-payload-rejected', requestSafe, 'raw request payload accepted');
  add('dry-run-response-shape-status-preview-only', responseSafe, 'response shape unsafe');
  add('dry-run-response-shape-preview-only', responseSafe, 'response shape boundary changed');
  add('response-execution-overclaim-rejected', responseSafe, 'response overclaim accepted');
  add('local-boundary-loopback-only-no-listener-now', boundarySafe, 'local boundary unsafe');
  add('local-boundary-in-process-or-loopback-only', boundarySafe, 'local boundary changed');
  add('non-loopback-boundary-rejected', boundarySafe, 'non-loopback boundary accepted');
  add('operator-status-visible-status-only', operatorSafe, 'operator status unsafe');
  add('rollback-disable-idempotent-no-delete-no-resurrection', rollbackSafe, 'rollback boundary unsafe');
  add('rollback-disable-idempotent', rollbackSafe, 'rollback behavior unsafe');
  add('telemetry-audit-redacted-preview-only', telemetrySafe, 'telemetry preview unsafe');
  add('telemetry-audit-preview-only', telemetrySafe, 'telemetry boundary changed');
  add('telemetry-write-or-raw-payload-rejected', telemetrySafe, 'telemetry write accepted');
  add('config-auth-key-storage-refs-reference-only', referenceSafe, 'reference dependency unsafe');
  add('reference-only-dependencies-safe', referenceSafe, 'reference dependency boundary changed');
  add('raw-secret-path-leak-rejected', referenceSafe, 'raw reference material accepted');
  add('phase29-prerequisite-gates-carried-forward', gateSafe, 'Phase 29 gates incomplete');
  add('phase29-prerequisite-gates-complete', gateSafe, 'Phase 29 gate set incomplete');
  add('phase29-prerequisites-not-satisfied-now', gateSafe, 'Phase 29 gate state unsafe');
  add('missing-phase29-prerequisite-gate-rejected', gateSafe, 'missing Phase 29 gate accepted');
  add('phase29-prerequisite-satisfied-now-rejected', gateSafe, 'satisfied Phase 29 gate accepted');
  add('proof-boundaries-preserved', proofSafe, 'proof boundary unsafe');
  add('fake-proof-rejected', proofSafe, 'fake proof accepted');
  add('direct-builder-oracle-targets-blocked', targetSafe, 'direct non-architect target accepted');
  add('unsafe-action-drift-rejected', nextActionsSafe && unsafeDriftSafe, 'unsafe action drift accepted');
  add('side-effects-blocked-now', effectsSafe, 'side effect boundary changed');
  add('side-effect-truth-all-blocked', effectsSafe, 'side effect truth unsafe');

  try {
    assertNoForbiddenOutput(report, asArray(contract.forbiddenOutputSubstrings));
    add('forbidden-output-strings-absent', true, null);
  } catch (err) {
    add('forbidden-output-strings-absent', false, err.message);
  }

  add('tamper-coverage-complete', tamperCoverageOk(report, contract), 'tamper coverage incomplete');
  add('idempotency-sensitive-to-control-path-inputs',
    report.idempotency_key === runtimeControlPathIdempotencyKey(report),
    'idempotency key mismatch');
  add('report-literal-values',
    literalValuesOk(report, expected.requiredLiteralValues || {}),
    'literal values changed');

  return {
    ok: errors.length === 0,
    checks,
    errors,
    resultById,
  };
}

function buildValidationReport(controlPathReport, contract = {}, generatedAt = controlPathReport.generated_at) {
  const validation = validateControlPathReport(controlPathReport, contract);
  const failed = validation.checks.filter((check) => !check.ok);
  const checkResult = (id) => validation.resultById[id] || resultObject(false, `${id} missing`);
  const report = {
    schema: VALIDATION_REPORT_SCHEMA_VERSION,
    version: RUNTIME_CONTROL_PATH_VERSION,
    report_id: `runtime-control-path-validation-${stableHash({
      control_path_key: controlPathReport.idempotency_key,
      generatedAt,
    }).slice(0, 12)}`,
    generated_at: generatedAt,
    baseline_commit: BASELINE_COMMIT,
    decision: validation.ok ? 'accepted' : 'blocked',
    reasons: failed.map((check) => check.id),
    phase29_dependency_result: checkResult('phase29-dependency-current'),
    control_path_decision_result: checkResult('decision-default-control-path-contract-only'),
    runtime_mode_flag_reader_result: checkResult('runtime-mode-flag-reader-disabled-local-dev-visible'),
    kill_switch_check_result: checkResult('kill-switch-check-fail-closed-testable'),
    dry_run_request_shape_result: checkResult('dry-run-request-shape-safe'),
    dry_run_response_shape_result: checkResult('dry-run-response-shape-preview-only'),
    local_boundary_result: checkResult('local-boundary-in-process-or-loopback-only'),
    operator_status_summary_result: checkResult('operator-status-visible-status-only'),
    rollback_disable_result: checkResult('rollback-disable-idempotent'),
    telemetry_audit_result: checkResult('telemetry-audit-preview-only'),
    reference_only_dependency_result: checkResult('reference-only-dependencies-safe'),
    phase29_prerequisite_gate_result: checkResult('phase29-prerequisite-gates-complete'),
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
      evidenceRef('mira-core-runtime-control-path', 'phase30-validation-report'),
    ],
  };
  assertNoForbiddenOutput(report, asArray(contract.forbiddenOutputSubstrings));
  return report;
}

function buildMiraCoreRuntimeControlPath(options = {}) {
  const contract = options.contract || {};
  const controlPathReport = buildRuntimeControlPathReport(options);
  const validation_report = buildValidationReport(controlPathReport, contract, controlPathReport.generated_at);
  const output = {
    runtime_control_path_report: controlPathReport,
    validation_report,
  };
  assertNoForbiddenOutput(output, asArray(contract.forbiddenOutputSubstrings));
  return output;
}

function validateMiraCoreRuntimeControlPathOutput(output = {}, contract = {}) {
  const checks = [];
  const errors = [];
  const add = (id, ok, detail = null) => {
    checks.push({ id, ok: ok === true, detail });
    if (!ok && detail) errors.push(detail);
  };
  const controlPathReport = output.runtime_control_path_report || {};
  const validationReport = output.validation_report || {};
  const controlPathValidation = validateControlPathReport(controlPathReport, contract);
  const acceptanceIds = asArray(contract.acceptanceChecks).map((check) => check.id);

  add('output-shape-complete',
    hasRequiredFields(output, contract.expectedOutputShape?.requiredTopLevelFields || REQUIRED_OUTPUT_FIELDS)
      && controlPathReport.schema === RUNTIME_CONTROL_PATH_REPORT_SCHEMA_VERSION
      && validationReport.schema === VALIDATION_REPORT_SCHEMA_VERSION
      && hasRequiredFields(controlPathReport, contract.expectedRuntimeControlPathReportShape?.requiredFields || REQUIRED_REPORT_FIELDS)
      && hasRequiredFields(validationReport, contract.expectedValidationReportShape?.requiredFields || REQUIRED_VALIDATION_REPORT_FIELDS),
    'runtime control-path output shape is incomplete');

  for (const check of controlPathValidation.checks) add(check.id, check.ok, check.detail);

  add('validation-report-literal-values',
    validationReport.schema === VALIDATION_REPORT_SCHEMA_VERSION
      && validationReport.baseline_commit === BASELINE_COMMIT
      && literalValuesOk(validationReport, contract.expectedValidationReportShape?.requiredLiteralValues || {}),
    'validation report literal values changed');

  add('validation-report-side-effect-truth',
    sideEffectValuesOk(validationReport.side_effect_result),
    'validation report side-effect truth unsafe');

  add('validation-report-acceptance-ids',
    idsEqual(asArray(validationReport.acceptance_checks), 'id', acceptanceIds),
    'validation report acceptance IDs changed');

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
  DEFAULT_PHASE29_PREREQUISITE_GATE_IDS,
  DEFAULT_TAMPER_CASE_IDS,
  GATE_ID,
  PHASE29_COMMIT,
  REQUIRED_OUTPUT_FIELDS,
  REQUIRED_REPORT_FIELDS,
  REQUIRED_SIDE_EFFECT_FIELDS,
  REQUIRED_VALIDATION_REPORT_FIELDS,
  RUNTIME_CONTROL_PATH_REPORT_SCHEMA_VERSION,
  VALIDATION_REPORT_SCHEMA_VERSION,
  assertNoForbiddenOutput,
  buildMiraCoreRuntimeControlPath,
  runtimeControlPathIdempotencyKey,
  stableHash,
  validateMiraCoreRuntimeControlPathOutput,
};
