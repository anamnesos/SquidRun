'use strict';

const crypto = require('crypto');

const RUNTIME_CONTROLS_REPORT_SCHEMA_VERSION = 'squidrun.mira_core.runtime_controls_report.v0';
const VALIDATION_REPORT_SCHEMA_VERSION = 'squidrun.mira_core.runtime_controls_validation_report.v0';
const RUNTIME_CONTROLS_VERSION = 'v0';
const BASELINE_COMMIT = '3efa9c5';
const CANDIDATE_SLICE_ID = 'runtime_slice_0_local_in_process_status_only';

const REQUIRED_OUTPUT_FIELDS = Object.freeze([
  'runtime_controls_report',
  'validation_report',
]);

const REQUIRED_REPORT_FIELDS = Object.freeze([
  'schema',
  'version',
  'controls_report_id',
  'idempotency_key',
  'generated_at',
  'profile',
  'sessionId',
  'deviceId',
  'baseline_commit',
  'phase_25_dependency',
  'runtime_mode_flag',
  'local_binding_plan',
  'operator_kill_switch',
  'dry_run_fallback',
  'rollback_disable_plan',
  'telemetry_audit_plan',
  'port_config_refs',
  'phase_ref_map',
  'proof_boundaries',
  'hard_out_of_scope',
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
  'phase_25_dependency_result',
  'runtime_mode_flag_result',
  'local_binding_result',
  'kill_switch_result',
  'dry_run_result',
  'rollback_disable_result',
  'telemetry_audit_result',
  'port_config_result',
  'phase_ref_result',
  'proof_boundary_result',
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

const DEFAULT_PHASE_REF_IDS = Object.freeze([
  'phase15-identity-signing-reference-only',
  'phase16-auth-binding-reference-only',
  'phase17-storage-retention-reference-only',
  'phase18-persistence-audit-reference-only',
  'phase19-encryption-key-reference-only',
  'phase20-server-api-reference-only',
  'phase21-server-handler-reference-only',
  'phase22-runtime-harness-reference-only',
  'phase23-milestone-readiness-reference-only',
  'phase24-runtime-promotion-gate-reference-only',
  'phase25-runtime-slice-candidate-reference-only',
]);

const DEFAULT_HARD_OUT_OF_SCOPE_IDS = Object.freeze([
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

const DEFAULT_NEXT_SAFE_ACTION_IDS = Object.freeze([
  'implement-phase26-validator-only',
  'review-controls-before-runtime-eligibility',
]);

const DEFAULT_TAMPER_CASE_IDS = Object.freeze([
  'tamper-runtime-flag-default-on',
  'tamper-non-loopback-binding',
  'tamper-hidden-network-listener',
  'tamper-missing-kill-switch',
  'tamper-kill-switch-ignored',
  'tamper-dry-run-bypass',
  'tamper-telemetry-write',
  'tamper-raw-secret-leak',
  'tamper-config-eligibility-authorizes-runtime',
  'tamper-stale-phase25-baseline',
]);

const DEFAULT_FORBIDDEN_OUTPUT_SUBSTRINGS = Object.freeze([
  'runtime flag enabled',
  'runtime enabled',
  'runtime authorized',
  'runtime started',
  'config proves runtime',
  'daemon started',
  'server started',
  'listener bound',
  'route registered',
  'http server listening',
  'websocket listening',
  'network request performed',
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

function evidenceRef(store, eventId, relation = 'runtime_controls_validation') {
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

function controlsExpected(contract = {}) {
  return contract.expectedRuntimeControlsReportShape || {};
}

function phaseRefIds(contract = {}) {
  return asArray(controlsExpected(contract).phaseRefMapRequiredIds).length > 0
    ? controlsExpected(contract).phaseRefMapRequiredIds
    : DEFAULT_PHASE_REF_IDS;
}

function hardOutOfScopeIds(contract = {}) {
  return asArray(controlsExpected(contract).hardOutOfScopeRequiredIds).length > 0
    ? controlsExpected(contract).hardOutOfScopeRequiredIds
    : DEFAULT_HARD_OUT_OF_SCOPE_IDS;
}

function nextSafeActionIds(contract = {}) {
  return asArray(controlsExpected(contract).nextSafeActionRequiredIds).length > 0
    ? controlsExpected(contract).nextSafeActionRequiredIds
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

function phase25Dependency() {
  return {
    dependency_id: 'phase_25_runtime_slice_candidate',
    fixture_path: 'ui/__tests__/fixtures/mira-core-runtime-slice-contract.json',
    module_path: 'ui/modules/mira-core/runtime-slice.js',
    cli_path: 'ui/scripts/hm-mira-core-runtime-slice.js',
    test_path: 'ui/__tests__/mira-core-runtime-slice.test.js',
    baseline_commit: BASELINE_COMMIT,
    status: 'candidate_green_validation_only',
    candidate_slice_id: CANDIDATE_SLICE_ID,
    runtime_available_now: false,
    does_not_authorize_runtime: true,
    missing_gate_count: 20,
    evidenceRefs: [
      evidenceRef('mira-core-runtime-slice', 'phase25-candidate-green'),
      evidenceRef('git', BASELINE_COMMIT, 'phase25_baseline_commit'),
    ],
  };
}

function runtimeModeFlag() {
  return {
    flag_id: 'mira_core_runtime_slice_0_mode',
    default_state: 'disabled',
    default_enabled: false,
    allowed_values: [
      'disabled',
      'future_review_only',
    ],
    dev_only: true,
    local_only: true,
    operator_visible: true,
    non_authorizing: true,
    runtime_started: false,
    invalid_value_behavior: 'validation_status_preview_only',
    evidenceRefs: [
      evidenceRef('mira-core-runtime-controls', 'runtime-mode-flag'),
    ],
  };
}

function localBindingPlan() {
  return {
    binding_id: 'runtime_slice_0_loopback_binding_plan',
    loopback_only: true,
    allowed_hosts: [
      '127.0.0.1',
      '::1',
      'localhost',
    ],
    blocked_hosts: [
      '0.0.0.0',
      'public_interface',
      'remote_interface',
    ],
    public_interface_allowed: false,
    remote_interface_allowed: false,
    listener_opened: false,
    network_performed: false,
    port_ref: 'phase26:port-binding-reference',
    evidenceRefs: [
      evidenceRef('mira-core-runtime-controls', 'local-binding-plan'),
    ],
  };
}

function operatorKillSwitch() {
  return {
    control_id: 'runtime_slice_0_operator_disable',
    operator_visible: true,
    fail_closed: true,
    testable: true,
    ignored_allowed: false,
    runtime_side_effects_now: false,
    default_when_unknown: 'disabled',
    evidenceRefs: [
      evidenceRef('mira-core-runtime-controls', 'operator-kill-switch'),
    ],
  };
}

function dryRunFallback() {
  return {
    fallback_id: 'runtime_slice_0_preview_fallback',
    all_requests_preview_only_when_flag_missing_false_invalid: true,
    invalid_flag_behavior: 'validation_status_preview_only',
    false_flag_behavior: 'validation_status_preview_only',
    missing_flag_behavior: 'validation_status_preview_only',
    bypass_allowed: false,
    response_mode: 'validation_status_preview_only',
    evidenceRefs: [
      evidenceRef('mira-core-runtime-controls', 'dry-run-fallback'),
    ],
  };
}

function rollbackDisablePlan() {
  return {
    plan_id: 'runtime_slice_0_disable_plan',
    disable_idempotent: true,
    deletes_data: false,
    resurrects_blocked_state: false,
    rollback_requires_runtime_stop_first: true,
    safe_repeat_behavior: 'repeat_disable_remains_noop_preview',
    evidenceRefs: [
      evidenceRef('mira-core-runtime-controls', 'rollback-disable-plan'),
    ],
  };
}

function telemetryAuditPlan() {
  return {
    plan_id: 'runtime_slice_0_redacted_audit_preview',
    redacted_audit_preview_only: true,
    store_write_now: false,
    file_write_now: false,
    db_write_now: false,
    network_write_now: false,
    raw_payload_allowed: false,
    evidenceRefs: [
      evidenceRef('mira-core-runtime-controls', 'telemetry-audit-plan'),
    ],
  };
}

function portConfigRefs() {
  return {
    config_id: 'runtime_slice_0_reference_only_config',
    reference_only: true,
    port_ref: 'phase26:port-reference',
    binding_host_ref: 'phase26:loopback-host-reference',
    storage_path_ref: 'phase26:storage-reference',
    auth_secret_presence_ref: 'phase26:secret-presence-reference',
    port_opened: false,
    env_secret_read: false,
    network_performed: false,
    raw_secret_allowed: false,
    raw_path_allowed: false,
    evidenceRefs: [
      evidenceRef('mira-core-runtime-controls', 'port-config-refs'),
    ],
  };
}

function phaseRefMap(contract = {}) {
  return phaseRefIds(contract).map((refId) => ({
    ref_id: refId,
    reference_only: true,
    behavior_performed: false,
    required_before_future_review: true,
    evidenceRefs: [
      evidenceRef('mira-core-runtime-controls', `phase-ref:${refId}`),
    ],
  }));
}

function proofBoundaries() {
  return {
    config_present_is_runtime_proof: false,
    socket_is_bridge_green_proof: false,
    delivery_acceptance_is_model_processing_proof: false,
    server_can_execute_local_arms: false,
    builder_direct_server_target_allowed: false,
    oracle_direct_server_target_allowed: false,
    evidenceRefs: [
      evidenceRef('mira-core-runtime-controls', 'proof-boundaries'),
    ],
  };
}

function hardOutOfScope(contract = {}) {
  return hardOutOfScopeIds(contract).map((scopeId) => ({
    scope_id: scopeId,
    out_of_scope_now: true,
    allowed_now: false,
    evidenceRefs: [
      evidenceRef('mira-core-runtime-controls', `out-of-scope:${scopeId}`),
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
      evidenceRef('mira-core-runtime-controls-tests', caseId),
    ],
  }));
}

function nextSafeActions(contract = {}) {
  const titles = {
    'implement-phase26-validator-only': 'Finish the Phase 26 validator',
    'review-controls-before-runtime-eligibility': 'Review controls before any later runtime review',
  };
  return nextSafeActionIds(contract).map((actionId) => ({
    action_id: actionId,
    title: titles[actionId] || actionId.replace(/-/g, ' '),
    risk_tier: 'tier0_read_only',
    allowed: true,
    why_safe: 'This only validates operator controls and config gate metadata.',
    evidenceRefs: [
      evidenceRef('mira-core-runtime-controls', `next-safe-action:${actionId}`),
    ],
  }));
}

function canonicalControlsReportInput(report) {
  return {
    baseline_commit: report.baseline_commit,
    profile: report.profile,
    sessionId: report.sessionId,
    deviceId: report.deviceId,
    phase_25_dependency: report.phase_25_dependency,
    runtime_mode_flag: report.runtime_mode_flag,
    local_binding_plan: report.local_binding_plan,
    operator_kill_switch: report.operator_kill_switch,
    dry_run_fallback: report.dry_run_fallback,
    rollback_disable_plan: report.rollback_disable_plan,
    telemetry_audit_plan: report.telemetry_audit_plan,
    port_config_refs: report.port_config_refs,
    phase_ref_map: report.phase_ref_map,
    proof_boundaries: report.proof_boundaries,
    hard_out_of_scope: report.hard_out_of_scope,
    tamper_case_coverage: report.tamper_case_coverage,
    next_safe_actions: report.next_safe_actions,
    side_effect_result: report.side_effect_result,
  };
}

function runtimeControlsIdempotencyKey(report) {
  return `runtime-controls:${stableHash(canonicalControlsReportInput(report))}`;
}

function buildControlsReport(options = {}) {
  const contract = options.contract || {};
  const inputSignals = options.inputSignals || {};
  const scope = normalizeScope(inputSignals);
  const generatedAt = generatedAtFromOptions(options, inputSignals);
  const report = {
    schema: RUNTIME_CONTROLS_REPORT_SCHEMA_VERSION,
    version: RUNTIME_CONTROLS_VERSION,
    controls_report_id: null,
    idempotency_key: null,
    generated_at: generatedAt,
    profile: scope.profile,
    sessionId: scope.sessionId,
    deviceId: scope.deviceId,
    baseline_commit: BASELINE_COMMIT,
    phase_25_dependency: phase25Dependency(),
    runtime_mode_flag: runtimeModeFlag(),
    local_binding_plan: localBindingPlan(),
    operator_kill_switch: operatorKillSwitch(),
    dry_run_fallback: dryRunFallback(),
    rollback_disable_plan: rollbackDisablePlan(),
    telemetry_audit_plan: telemetryAuditPlan(),
    port_config_refs: portConfigRefs(),
    phase_ref_map: phaseRefMap(contract),
    proof_boundaries: proofBoundaries(),
    hard_out_of_scope: hardOutOfScope(contract),
    tamper_case_coverage: tamperCaseCoverage(contract),
    next_safe_actions: nextSafeActions(contract),
    evidenceRefs: [
      evidenceRef('mira-core-runtime-controls', 'phase26-controls-report'),
      evidenceRef('git', BASELINE_COMMIT, 'phase25_baseline_commit'),
    ],
    side_effect_result: sideEffectResult(),
  };
  report.idempotency_key = runtimeControlsIdempotencyKey(report);
  report.controls_report_id = `runtime-controls-${stableHash(report.idempotency_key).slice(0, 12)}`;
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

function phase25DependencyOk(report, contract = {}) {
  const dependency = report.phase_25_dependency || {};
  const expected = controlsExpected(contract);
  return hasRequiredFields(dependency, expected.phase25DependencyRequiredFields || [])
    && Object.entries(expected.phase25DependencyRequiredValues || {}).every(([field, value]) => valuesMatch(dependency[field], value))
    && dependency.baseline_commit === BASELINE_COMMIT
    && dependency.candidate_slice_id === CANDIDATE_SLICE_ID
    && dependency.runtime_available_now === false
    && dependency.does_not_authorize_runtime === true
    && asArray(dependency.evidenceRefs).length > 0;
}

function runtimeModeFlagOk(report, contract = {}) {
  const flag = report.runtime_mode_flag || {};
  const expected = controlsExpected(contract);
  return hasRequiredFields(flag, expected.runtimeModeFlagRequiredFields || [])
    && flag.default_enabled === false
    && flag.default_state === 'disabled'
    && asArray(flag.allowed_values).includes('disabled')
    && flag.dev_only === true
    && flag.local_only === true
    && flag.operator_visible === true
    && flag.non_authorizing === true
    && flag.runtime_started === false
    && flag.invalid_value_behavior === 'validation_status_preview_only'
    && asArray(flag.evidenceRefs).length > 0;
}

function localBindingOk(report, contract = {}) {
  const binding = report.local_binding_plan || {};
  const expected = controlsExpected(contract);
  return hasRequiredFields(binding, expected.localBindingPlanRequiredFields || [])
    && binding.loopback_only === true
    && valuesMatch(binding.allowed_hosts, ['127.0.0.1', '::1', 'localhost'])
    && !asArray(binding.allowed_hosts).some((host) => ['0.0.0.0', '*'].includes(host))
    && binding.public_interface_allowed === false
    && binding.remote_interface_allowed === false
    && binding.listener_opened === false
    && binding.network_performed === false
    && typeof binding.port_ref === 'string'
    && asArray(binding.evidenceRefs).length > 0;
}

function killSwitchOk(report, contract = {}) {
  const control = report.operator_kill_switch || {};
  const expected = controlsExpected(contract);
  return hasRequiredFields(control, expected.operatorKillSwitchRequiredFields || [])
    && control.operator_visible === true
    && control.fail_closed === true
    && control.testable === true
    && control.ignored_allowed === false
    && control.runtime_side_effects_now === false
    && control.default_when_unknown === 'disabled'
    && asArray(control.evidenceRefs).length > 0;
}

function dryRunFallbackOk(report, contract = {}) {
  const fallback = report.dry_run_fallback || {};
  const expected = controlsExpected(contract);
  return hasRequiredFields(fallback, expected.dryRunFallbackRequiredFields || [])
    && fallback.all_requests_preview_only_when_flag_missing_false_invalid === true
    && fallback.invalid_flag_behavior === 'validation_status_preview_only'
    && fallback.false_flag_behavior === 'validation_status_preview_only'
    && fallback.missing_flag_behavior === 'validation_status_preview_only'
    && fallback.bypass_allowed === false
    && fallback.response_mode === 'validation_status_preview_only'
    && asArray(fallback.evidenceRefs).length > 0;
}

function rollbackDisableOk(report, contract = {}) {
  const plan = report.rollback_disable_plan || {};
  const expected = controlsExpected(contract);
  return hasRequiredFields(plan, expected.rollbackDisablePlanRequiredFields || [])
    && plan.disable_idempotent === true
    && plan.deletes_data === false
    && plan.resurrects_blocked_state === false
    && plan.rollback_requires_runtime_stop_first === true
    && typeof plan.safe_repeat_behavior === 'string'
    && asArray(plan.evidenceRefs).length > 0;
}

function telemetryAuditOk(report, contract = {}) {
  const plan = report.telemetry_audit_plan || {};
  const expected = controlsExpected(contract);
  return hasRequiredFields(plan, expected.telemetryAuditPlanRequiredFields || [])
    && plan.redacted_audit_preview_only === true
    && plan.store_write_now === false
    && plan.file_write_now === false
    && plan.db_write_now === false
    && plan.network_write_now === false
    && plan.raw_payload_allowed === false
    && asArray(plan.evidenceRefs).length > 0;
}

function portConfigOk(report, contract = {}) {
  const refs = report.port_config_refs || {};
  const expected = controlsExpected(contract);
  return hasRequiredFields(refs, expected.portConfigRefsRequiredFields || [])
    && refs.reference_only === true
    && typeof refs.port_ref === 'string'
    && typeof refs.binding_host_ref === 'string'
    && typeof refs.storage_path_ref === 'string'
    && typeof refs.auth_secret_presence_ref === 'string'
    && refs.port_opened === false
    && refs.env_secret_read === false
    && refs.network_performed === false
    && refs.raw_secret_allowed === false
    && refs.raw_path_allowed === false
    && asArray(refs.evidenceRefs).length > 0;
}

function phaseRefsOk(report, contract = {}) {
  const refs = asArray(report.phase_ref_map);
  const requiredIds = phaseRefIds(contract);
  return refs.length === requiredIds.length
    && idsEqual(refs, 'ref_id', requiredIds)
    && refs.every((ref) => ref.reference_only === true
      && ref.behavior_performed === false
      && ref.required_before_future_review === true
      && asArray(ref.evidenceRefs).length > 0);
}

function proofBoundariesOk(report, contract = {}) {
  const proof = report.proof_boundaries || {};
  const expected = controlsExpected(contract);
  return hasRequiredFields(proof, expected.proofBoundaryRequiredFields || [])
    && proof.config_present_is_runtime_proof === false
    && proof.socket_is_bridge_green_proof === false
    && proof.delivery_acceptance_is_model_processing_proof === false
    && proof.server_can_execute_local_arms === false
    && proof.builder_direct_server_target_allowed === false
    && proof.oracle_direct_server_target_allowed === false
    && asArray(proof.evidenceRefs).length > 0;
}

function hardOutOfScopeOk(report, contract = {}) {
  const scopes = asArray(report.hard_out_of_scope);
  const requiredIds = hardOutOfScopeIds(contract);
  return scopes.length === requiredIds.length
    && idsEqual(scopes, 'scope_id', requiredIds)
    && scopes.every((scope) => scope.out_of_scope_now === true
      && scope.allowed_now === false
      && asArray(scope.evidenceRefs).length > 0)
    && sideEffectValuesOk(report.side_effect_result);
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
      throw new Error(`runtime_controls_forbidden_substring:${forbidden}`);
    }
  }
}

function validateControlsReport(report = {}, contract = {}) {
  const checks = [];
  const errors = [];
  const resultById = {};
  const add = (id, ok, detail = null, extra = {}) => {
    const result = resultObject(ok, detail, { id, ...extra });
    checks.push(result);
    resultById[id] = result;
    if (!ok && detail) errors.push(detail);
  };
  const expected = controlsExpected(contract);

  add('output-shape-complete',
    report.schema === RUNTIME_CONTROLS_REPORT_SCHEMA_VERSION
      && hasRequiredFields(report, expected.requiredFields || REQUIRED_REPORT_FIELDS),
    'Runtime controls report shape is incomplete.');

  add('baseline-3efa9c5-pinned',
    report.baseline_commit === BASELINE_COMMIT,
    'Baseline commit must stay pinned to 3efa9c5.');

  add('phase25-runtime-slice-candidate-required',
    phase25DependencyOk(report, contract),
    'Phase 25 dependency is missing, stale, or authorizing.');

  add('runtime-mode-flag-disabled-local-dev-nonauthorizing',
    runtimeModeFlagOk(report, contract),
    'Runtime mode flag is unsafe or overclaimed.');

  add('local-binding-loopback-only-no-listener',
    localBindingOk(report, contract),
    'Binding plan is not loopback-only or claims side effects.');

  add('operator-kill-switch-visible-fail-closed',
    killSwitchOk(report, contract),
    'Operator kill switch is missing or unsafe.');

  add('dry-run-fallback-cannot-be-bypassed',
    dryRunFallbackOk(report, contract),
    'Dry-run fallback can be bypassed.');

  add('rollback-disable-idempotent-no-resurrection',
    rollbackDisableOk(report, contract),
    'Rollback/disable plan is unsafe.');

  add('telemetry-audit-preview-only-no-writes',
    telemetryAuditOk(report, contract),
    'Telemetry/audit plan is not preview-only.');

  add('port-config-reference-only-no-secret-read',
    portConfigOk(report, contract),
    'Port/config refs are not reference-only.');

  add('phase15-through-25-refs-reference-only',
    phaseRefsOk(report, contract),
    'Phase refs are incomplete or perform behavior.');

  add('proof-boundaries-preserved',
    proofBoundariesOk(report, contract),
    'Proof boundaries were overclaimed.');

  add('hard-out-of-scope-side-effects-blocked',
    hardOutOfScopeOk(report, contract),
    'Hard out-of-scope behavior or side-effect truth is unsafe.');

  add('default-on-overclaim-rejected',
    report.runtime_mode_flag?.default_enabled === false
      && report.runtime_mode_flag?.default_state === 'disabled'
      && report.runtime_mode_flag?.dev_only === true
      && report.runtime_mode_flag?.local_only === true
      && report.runtime_mode_flag?.non_authorizing === true
      && report.runtime_mode_flag?.runtime_started === false,
    'Default-on or authorizing flag overclaim was accepted.');

  add('non-loopback-binding-rejected',
    report.local_binding_plan?.loopback_only === true
      && valuesMatch(report.local_binding_plan?.allowed_hosts, ['127.0.0.1', '::1', 'localhost'])
      && report.local_binding_plan?.public_interface_allowed === false
      && report.local_binding_plan?.remote_interface_allowed === false
      && report.local_binding_plan?.listener_opened === false
      && report.local_binding_plan?.network_performed === false
      && report.port_config_refs?.port_opened === false,
    'Non-loopback binding was accepted.');

  try {
    assertNoForbiddenOutput(report, asArray(contract.forbiddenOutputSubstrings));
    add('raw-private-secret-leakage-rejected', true, null);
  } catch (err) {
    add('raw-private-secret-leakage-rejected', false, err.message);
  }

  add('config-eligibility-not-authorization',
    report.runtime_mode_flag?.non_authorizing === true
      && report.proof_boundaries?.config_present_is_runtime_proof === false
      && report.phase_25_dependency?.does_not_authorize_runtime === true,
    'Config eligibility was treated as authorization.');

  add('stale-phase25-baseline-rejected',
    report.phase_25_dependency?.baseline_commit === BASELINE_COMMIT
      && report.phase_25_dependency?.candidate_slice_id === CANDIDATE_SLICE_ID
      && report.phase_25_dependency?.does_not_authorize_runtime === true,
    'Stale Phase 25 baseline or candidate was accepted.');

  add('hidden-listener-network-rejected',
    report.local_binding_plan?.listener_opened === false
      && report.local_binding_plan?.network_performed === false
      && report.port_config_refs?.port_opened === false
      && report.port_config_refs?.network_performed === false
      && sideEffectValuesOk(report.side_effect_result),
    'Hidden listener/network behavior was accepted.');

  add('kill-switch-missing-or-ignored-rejected',
    killSwitchOk(report, contract),
    'Missing or ignored kill switch was accepted.');

  add('dry-run-bypass-rejected',
    dryRunFallbackOk(report, contract),
    'Dry-run bypass was accepted.');

  add('telemetry-write-rejected',
    telemetryAuditOk(report, contract),
    'Telemetry/audit write was accepted.');

  add('raw-secret-leak-rejected',
    portConfigOk(report, contract),
    'Raw secret/path config was accepted.');

  add('tamper-coverage-complete',
    tamperCoverageOk(report, contract),
    'Tamper case coverage is incomplete.');

  add('next-safe-actions-complete',
    nextSafeActionsOk(report, contract),
    'Next safe actions are missing or unsafe.');

  add('idempotency-sensitive-to-control-gates',
    report.idempotency_key === runtimeControlsIdempotencyKey(report),
    'Runtime controls idempotency key is unstable.');

  add('report-literal-values',
    literalValuesOk(report, expected.requiredLiteralValues || {}),
    'Runtime controls literal values changed.');

  return {
    ok: errors.length === 0,
    checks,
    errors,
    resultById,
  };
}

function buildValidationReport(controlsReport, contract = {}, generatedAt = controlsReport.generated_at) {
  const validation = validateControlsReport(controlsReport, contract);
  const failed = validation.checks.filter((check) => !check.ok);
  const checkResult = (id) => validation.resultById[id] || resultObject(false, `${id} missing`);
  const report = {
    schema: VALIDATION_REPORT_SCHEMA_VERSION,
    version: RUNTIME_CONTROLS_VERSION,
    report_id: `runtime-controls-validation-${stableHash({
      controls_key: controlsReport.idempotency_key,
      generatedAt,
    }).slice(0, 12)}`,
    generated_at: generatedAt,
    baseline_commit: BASELINE_COMMIT,
    decision: validation.ok ? 'accepted' : 'blocked',
    reasons: failed.map((check) => check.detail || check.id),
    phase_25_dependency_result: checkResult('phase25-runtime-slice-candidate-required'),
    runtime_mode_flag_result: checkResult('runtime-mode-flag-disabled-local-dev-nonauthorizing'),
    local_binding_result: checkResult('local-binding-loopback-only-no-listener'),
    kill_switch_result: checkResult('operator-kill-switch-visible-fail-closed'),
    dry_run_result: checkResult('dry-run-fallback-cannot-be-bypassed'),
    rollback_disable_result: checkResult('rollback-disable-idempotent-no-resurrection'),
    telemetry_audit_result: checkResult('telemetry-audit-preview-only-no-writes'),
    port_config_result: checkResult('port-config-reference-only-no-secret-read'),
    phase_ref_result: checkResult('phase15-through-25-refs-reference-only'),
    proof_boundary_result: checkResult('proof-boundaries-preserved'),
    side_effect_result: sideEffectResult(),
    acceptance_checks: asArray(contract.acceptanceChecks).map((check) => ({
      id: check.id,
      ok: validation.ok,
    })),
    failed_checks: failed.map((check) => check.id),
    evidenceRefs: [
      evidenceRef('mira-core-runtime-controls', 'phase26-validation-report'),
    ],
  };
  assertNoForbiddenOutput(report, asArray(contract.forbiddenOutputSubstrings));
  return report;
}

function buildMiraCoreRuntimeControls(options = {}) {
  const contract = options.contract || {};
  const controlsReport = buildControlsReport(options);
  const validation_report = buildValidationReport(controlsReport, contract, controlsReport.generated_at);
  const output = {
    runtime_controls_report: controlsReport,
    validation_report,
  };
  assertNoForbiddenOutput(output, asArray(contract.forbiddenOutputSubstrings));
  return output;
}

function validateMiraCoreRuntimeControlsOutput(output = {}, contract = {}) {
  const checks = [];
  const errors = [];
  const add = (id, ok, detail = null) => {
    checks.push({ id, ok: ok === true, detail });
    if (!ok && detail) errors.push(detail);
  };
  const controlsReport = output.runtime_controls_report || {};
  const validationReport = output.validation_report || {};
  const controlsValidation = validateControlsReport(controlsReport, contract);

  add('output-shape-complete',
    hasRequiredFields(output, contract.expectedOutputShape?.requiredTopLevelFields || REQUIRED_OUTPUT_FIELDS)
      && controlsReport.schema === RUNTIME_CONTROLS_REPORT_SCHEMA_VERSION
      && validationReport.schema === VALIDATION_REPORT_SCHEMA_VERSION
      && hasRequiredFields(controlsReport, contract.expectedRuntimeControlsReportShape?.requiredFields || REQUIRED_REPORT_FIELDS)
      && hasRequiredFields(validationReport, contract.expectedValidationReportShape?.requiredFields || REQUIRED_VALIDATION_REPORT_FIELDS),
    'Runtime controls output shape is incomplete.');

  for (const check of controlsValidation.checks) add(check.id, check.ok, check.detail);

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
  DEFAULT_HARD_OUT_OF_SCOPE_IDS,
  DEFAULT_NEXT_SAFE_ACTION_IDS,
  DEFAULT_PHASE_REF_IDS,
  DEFAULT_TAMPER_CASE_IDS,
  REQUIRED_OUTPUT_FIELDS,
  REQUIRED_REPORT_FIELDS,
  REQUIRED_SIDE_EFFECT_FIELDS,
  REQUIRED_VALIDATION_REPORT_FIELDS,
  RUNTIME_CONTROLS_REPORT_SCHEMA_VERSION,
  VALIDATION_REPORT_SCHEMA_VERSION,
  assertNoForbiddenOutput,
  buildMiraCoreRuntimeControls,
  runtimeControlsIdempotencyKey,
  stableHash,
  validateMiraCoreRuntimeControlsOutput,
};
