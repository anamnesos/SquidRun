'use strict';

const crypto = require('crypto');

const RUNTIME_PREFLIGHT_REPORT_SCHEMA_VERSION = 'squidrun.mira_core.runtime_preflight_report.v0';
const VALIDATION_REPORT_SCHEMA_VERSION = 'squidrun.mira_core.runtime_preflight_validation_report.v0';
const RUNTIME_PREFLIGHT_VERSION = 'v0';
const BASELINE_COMMIT = 'b125eee';
const PHASE25_COMMIT = '3efa9c5';
const CANDIDATE_SLICE_ID = 'runtime_slice_0_local_in_process_status_only';

const REQUIRED_OUTPUT_FIELDS = Object.freeze([
  'runtime_preflight_report',
  'validation_report',
]);

const REQUIRED_REPORT_FIELDS = Object.freeze([
  'schema',
  'version',
  'preflight_report_id',
  'idempotency_key',
  'generated_at',
  'profile',
  'sessionId',
  'deviceId',
  'baseline_commit',
  'phase_25_dependency',
  'phase_26_dependency',
  'candidate_runtime_slice',
  'controls_current',
  'readiness_decision',
  'readiness_decision_allowed_values',
  'eligible_is_authorization',
  'unsatisfied_gates',
  'proof_boundaries',
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
  'phase25_dependency_result',
  'phase26_dependency_result',
  'candidate_result',
  'controls_current_result',
  'readiness_decision_result',
  'unsatisfied_gates_result',
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

const DEFAULT_READINESS_DECISIONS = Object.freeze([
  'remain_validation_only',
  'blocked',
  'eligible_for_future_local_dry_run_preflight',
]);

const DEFAULT_UNSATISFIED_GATE_IDS = Object.freeze([
  'no-real-runtime-mode-implementation',
  'no-live-kill-switch-wiring',
  'no-tested-dry-run-runtime-path',
  'no-actual-local-only-binding-implementation',
  'no-real-telemetry-audit-sink',
  'no-storage-path-env-config-key-auth-binding',
  'no-operator-ui-status-surface',
  'no-rollback-exercise',
  'no-full-end-to-end-runtime-proof',
]);

const DEFAULT_BLOCKED_SIDE_EFFECT_IDS = Object.freeze([
  'runtime',
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
  'implement-phase27-validator-only',
  'review-preflight-before-any-runtime-dry-run',
]);

const DEFAULT_TAMPER_CASE_IDS = Object.freeze([
  'tamper-stale-phase25-baseline',
  'tamper-stale-phase26-baseline',
  'tamper-eligible-as-authorization',
  'tamper-missing-controls',
  'tamper-default-on-runtime',
  'tamper-non-loopback-binding',
  'tamper-hidden-listener-network',
  'tamper-fake-proof',
  'tamper-missing-unsatisfied-gates',
  'tamper-raw-secret-path-leak',
  'tamper-unsafe-action-drift',
]);

const DEFAULT_FORBIDDEN_OUTPUT_SUBSTRINGS = Object.freeze([
  'runtime authorized',
  'runtime available now',
  'runtime started',
  'preflight proves runtime',
  'config proves runtime',
  'eligible authorizes runtime',
  'server started',
  'listener bound',
  'route registered',
  'http server listening',
  'websocket listening',
  'network request performed',
  'public interface allowed',
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

function evidenceRef(store, eventId, relation = 'runtime_preflight_validation') {
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

function preflightExpected(contract = {}) {
  return contract.expectedRuntimePreflightReportShape || {};
}

function requiredGateIds(contract = {}) {
  return asArray(preflightExpected(contract).unsatisfiedGateRequiredIds).length > 0
    ? preflightExpected(contract).unsatisfiedGateRequiredIds
    : DEFAULT_UNSATISFIED_GATE_IDS;
}

function blockedSideEffectIds(contract = {}) {
  return asArray(preflightExpected(contract).blockedSideEffectRequiredIds).length > 0
    ? preflightExpected(contract).blockedSideEffectRequiredIds
    : DEFAULT_BLOCKED_SIDE_EFFECT_IDS;
}

function nextSafeActionIds(contract = {}) {
  return asArray(preflightExpected(contract).nextSafeActionRequiredIds).length > 0
    ? preflightExpected(contract).nextSafeActionRequiredIds
    : DEFAULT_NEXT_SAFE_ACTION_IDS;
}

function readinessDecisions(contract = {}) {
  return asArray(preflightExpected(contract).readinessDecisionAllowedValues).length > 0
    ? preflightExpected(contract).readinessDecisionAllowedValues
    : DEFAULT_READINESS_DECISIONS;
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
    phase: 'phase_25_first_runtime_slice_candidate',
    commit: PHASE25_COMMIT,
    fixture_path: 'ui/__tests__/fixtures/mira-core-runtime-slice-contract.json',
    module_path: 'ui/modules/mira-core/runtime-slice.js',
    cli_path: 'ui/scripts/hm-mira-core-runtime-slice.js',
    test_path: 'ui/__tests__/mira-core-runtime-slice.test.js',
    status: 'committed_validation_only',
    candidate_slice_id: CANDIDATE_SLICE_ID,
    runtime_available_now: false,
    non_authorizing: true,
    evidenceRefs: [
      evidenceRef('git', PHASE25_COMMIT, 'phase25_commit'),
      evidenceRef('mira-core-runtime-slice', 'phase25-candidate'),
    ],
  };
}

function phase26Dependency() {
  return {
    phase: 'phase_26_runtime_slice_0_operator_controls_config_gates',
    commit: BASELINE_COMMIT,
    fixture_path: 'ui/__tests__/fixtures/mira-core-runtime-controls-contract.json',
    module_path: 'ui/modules/mira-core/runtime-controls.js',
    cli_path: 'ui/scripts/hm-mira-core-runtime-controls.js',
    test_path: 'ui/__tests__/mira-core-runtime-controls.test.js',
    status: 'committed_validation_only',
    controls_current: true,
    evidenceRefs: [
      evidenceRef('git', BASELINE_COMMIT, 'phase26_commit'),
      evidenceRef('mira-core-runtime-controls', 'phase26-controls'),
    ],
  };
}

function candidateRuntimeSlice() {
  return {
    slice_id: CANDIDATE_SLICE_ID,
    local_only: true,
    dev_only: true,
    disabled_by_default: true,
    operator_visible: true,
    read_only_status_control_plane_only: true,
    runtime_available_now: false,
    non_authorizing: true,
    does_not_satisfy_phase_24_prerequisites: true,
    evidenceRefs: [
      evidenceRef('mira-core-runtime-slice', CANDIDATE_SLICE_ID),
    ],
  };
}

function controlsCurrent() {
  return {
    runtime_mode_flag: {
      default_state: 'disabled',
      default_enabled: false,
      dev_only: true,
      local_only: true,
      operator_visible: true,
      non_authorizing: true,
      runtime_started: false,
    },
    local_binding_plan: {
      loopback_only: true,
      allowed_hosts: [
        '127.0.0.1',
        '::1',
        'localhost',
      ],
      public_interface_allowed: false,
      remote_interface_allowed: false,
      listener_opened: false,
      network_performed: false,
      port_ref: 'phase27:port-reference',
    },
    operator_kill_switch: {
      visible: true,
      fail_closed: true,
      testable: true,
      wired_to_runtime_now: false,
      ignored_allowed: false,
    },
    dry_run_fallback: {
      preview_only: true,
      applies_when_flag_missing_false_invalid: true,
      bypass_allowed: false,
      tested_runtime_path_now: false,
    },
    rollback_disable_plan: {
      disable_idempotent: true,
      deletes_data: false,
      resurrects_blocked_state: false,
      rollback_exercised_now: false,
    },
    telemetry_audit_plan: {
      redacted_preview_only: true,
      store_write_now: false,
      file_write_now: false,
      db_write_now: false,
      real_sink_wired_now: false,
      raw_payload_allowed: false,
    },
    port_config_refs: {
      reference_only: true,
      port_ref: 'phase27:port-reference',
      storage_path_ref: 'phase27:storage-reference',
      auth_secret_presence_ref: 'phase27:auth-reference',
      key_ref: 'phase27:key-reference',
      port_opened: false,
      env_secret_read: false,
      raw_secret_allowed: false,
      raw_path_allowed: false,
    },
    phase15_to_24_refs_reference_only: true,
  };
}

function unsatisfiedGates(contract = {}) {
  return requiredGateIds(contract).map((gateId) => ({
    gate_id: gateId,
    status: 'unsatisfied',
    carried_forward: true,
    blocks_runtime_now: true,
    evidenceRefs: [
      evidenceRef('mira-core-runtime-preflight', `gate:${gateId}`),
    ],
  }));
}

function proofBoundaries() {
  return {
    preflight_ready_is_runtime_proof: false,
    config_present_is_runtime_proof: false,
    socket_is_bridge_green_proof: false,
    delivery_acceptance_is_model_processing_proof: false,
    server_can_execute_local_arms: false,
    builder_direct_server_target_allowed: false,
    oracle_direct_server_target_allowed: false,
    evidenceRefs: [
      evidenceRef('mira-core-runtime-preflight', 'proof-boundaries'),
    ],
  };
}

function blockedSideEffects(contract = {}) {
  return blockedSideEffectIds(contract).map((effectId) => ({
    effect_id: effectId,
    blocked_now: true,
    attempts: 0,
    evidenceRefs: [
      evidenceRef('mira-core-runtime-preflight', `blocked-effect:${effectId}`),
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
      evidenceRef('mira-core-runtime-preflight-tests', caseId),
    ],
  }));
}

function nextSafeActions(contract = {}) {
  const titles = {
    'implement-phase27-validator-only': 'Finish the Phase 27 validator',
    'review-preflight-before-any-runtime-dry-run': 'Review preflight before a later dry-run review',
  };
  const reasons = {
    'implement-phase27-validator-only': 'This only checks readiness metadata and side-effect truth.',
    'review-preflight-before-any-runtime-dry-run': 'This keeps any later dry-run review behind operator review and unsatisfied gates.',
  };
  return nextSafeActionIds(contract).map((actionId) => ({
    action_id: actionId,
    title: titles[actionId] || actionId.replace(/-/g, ' '),
    risk_tier: 'tier0_read_only',
    allowed: true,
    why_safe: reasons[actionId] || 'This is read-only validation metadata.',
    evidenceRefs: [
      evidenceRef('mira-core-runtime-preflight', `next-safe-action:${actionId}`),
    ],
  }));
}

function canonicalPreflightReportInput(report) {
  return {
    baseline_commit: report.baseline_commit,
    profile: report.profile,
    sessionId: report.sessionId,
    deviceId: report.deviceId,
    phase_25_dependency: report.phase_25_dependency,
    phase_26_dependency: report.phase_26_dependency,
    candidate_runtime_slice: report.candidate_runtime_slice,
    controls_current: report.controls_current,
    readiness_decision: report.readiness_decision,
    readiness_decision_allowed_values: report.readiness_decision_allowed_values,
    eligible_is_authorization: report.eligible_is_authorization,
    unsatisfied_gates: report.unsatisfied_gates,
    proof_boundaries: report.proof_boundaries,
    blocked_side_effects: report.blocked_side_effects,
    tamper_case_coverage: report.tamper_case_coverage,
    next_safe_actions: report.next_safe_actions,
    side_effect_result: report.side_effect_result,
  };
}

function runtimePreflightIdempotencyKey(report) {
  return `runtime-preflight:${stableHash(canonicalPreflightReportInput(report))}`;
}

function buildPreflightReport(options = {}) {
  const contract = options.contract || {};
  const inputSignals = options.inputSignals || {};
  const scope = normalizeScope(inputSignals);
  const generatedAt = generatedAtFromOptions(options, inputSignals);
  const allowedDecisions = readinessDecisions(contract);
  const requestedDecision = inputSignals.readinessDecision;
  const readinessDecision = allowedDecisions.includes(requestedDecision)
    ? requestedDecision
    : (preflightExpected(contract).requiredDefaultDecision || 'remain_validation_only');
  const report = {
    schema: RUNTIME_PREFLIGHT_REPORT_SCHEMA_VERSION,
    version: RUNTIME_PREFLIGHT_VERSION,
    preflight_report_id: null,
    idempotency_key: null,
    generated_at: generatedAt,
    profile: scope.profile,
    sessionId: scope.sessionId,
    deviceId: scope.deviceId,
    baseline_commit: BASELINE_COMMIT,
    phase_25_dependency: phase25Dependency(),
    phase_26_dependency: phase26Dependency(),
    candidate_runtime_slice: candidateRuntimeSlice(),
    controls_current: controlsCurrent(),
    readiness_decision: readinessDecision,
    readiness_decision_allowed_values: allowedDecisions,
    eligible_is_authorization: false,
    unsatisfied_gates: unsatisfiedGates(contract),
    proof_boundaries: proofBoundaries(),
    blocked_side_effects: blockedSideEffects(contract),
    tamper_case_coverage: tamperCaseCoverage(contract),
    next_safe_actions: nextSafeActions(contract),
    evidenceRefs: [
      evidenceRef('mira-core-runtime-preflight', 'phase27-preflight-report'),
      evidenceRef('git', BASELINE_COMMIT, 'phase26_commit'),
      evidenceRef('git', PHASE25_COMMIT, 'phase25_commit'),
    ],
    side_effect_result: sideEffectResult(),
  };
  report.idempotency_key = runtimePreflightIdempotencyKey(report);
  report.preflight_report_id = `runtime-preflight-${stableHash(report.idempotency_key).slice(0, 12)}`;
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
  const expected = preflightExpected(contract);
  return hasRequiredFields(dependency, expected.phase25DependencyRequiredFields || [])
    && Object.entries(expected.phase25DependencyRequiredValues || {}).every(([field, value]) => valuesMatch(dependency[field], value))
    && dependency.fixture_path === 'ui/__tests__/fixtures/mira-core-runtime-slice-contract.json'
    && dependency.module_path === 'ui/modules/mira-core/runtime-slice.js'
    && dependency.cli_path === 'ui/scripts/hm-mira-core-runtime-slice.js'
    && dependency.test_path === 'ui/__tests__/mira-core-runtime-slice.test.js'
    && dependency.commit === PHASE25_COMMIT
    && dependency.status === 'committed_validation_only'
    && dependency.candidate_slice_id === CANDIDATE_SLICE_ID
    && dependency.runtime_available_now === false
    && dependency.non_authorizing === true
    && asArray(dependency.evidenceRefs).length > 0;
}

function phase26DependencyOk(report, contract = {}) {
  const dependency = report.phase_26_dependency || {};
  const expected = preflightExpected(contract);
  return hasRequiredFields(dependency, expected.phase26DependencyRequiredFields || [])
    && Object.entries(expected.phase26DependencyRequiredValues || {}).every(([field, value]) => valuesMatch(dependency[field], value))
    && dependency.fixture_path === 'ui/__tests__/fixtures/mira-core-runtime-controls-contract.json'
    && dependency.module_path === 'ui/modules/mira-core/runtime-controls.js'
    && dependency.cli_path === 'ui/scripts/hm-mira-core-runtime-controls.js'
    && dependency.test_path === 'ui/__tests__/mira-core-runtime-controls.test.js'
    && dependency.commit === BASELINE_COMMIT
    && dependency.status === 'committed_validation_only'
    && dependency.controls_current === true
    && asArray(dependency.evidenceRefs).length > 0;
}

function candidateOk(report, contract = {}) {
  const candidate = report.candidate_runtime_slice || {};
  const expected = preflightExpected(contract);
  return hasRequiredFields(candidate, expected.candidateRuntimeSliceRequiredFields || [])
    && candidate.slice_id === CANDIDATE_SLICE_ID
    && candidate.local_only === true
    && candidate.dev_only === true
    && candidate.disabled_by_default === true
    && candidate.operator_visible === true
    && candidate.read_only_status_control_plane_only === true
    && candidate.runtime_available_now === false
    && candidate.non_authorizing === true
    && candidate.does_not_satisfy_phase_24_prerequisites === true
    && asArray(candidate.evidenceRefs).length > 0;
}

function runtimeModeFlagOk(report, contract = {}) {
  const flag = report.controls_current?.runtime_mode_flag || {};
  const expected = preflightExpected(contract);
  return hasRequiredFields(flag, expected.runtimeModeFlagRequiredFields || [])
    && flag.default_state === 'disabled'
    && flag.default_enabled === false
    && flag.dev_only === true
    && flag.local_only === true
    && flag.operator_visible === true
    && flag.non_authorizing === true
    && flag.runtime_started === false;
}

function localBindingOk(report, contract = {}) {
  const binding = report.controls_current?.local_binding_plan || {};
  const expected = preflightExpected(contract);
  return hasRequiredFields(binding, expected.localBindingPlanRequiredFields || [])
    && binding.loopback_only === true
    && valuesMatch(binding.allowed_hosts, ['127.0.0.1', '::1', 'localhost'])
    && !asArray(binding.allowed_hosts).some((host) => ['0.0.0.0', '*', 'public_interface', 'remote_interface'].includes(host))
    && binding.public_interface_allowed === false
    && binding.remote_interface_allowed === false
    && binding.listener_opened === false
    && binding.network_performed === false
    && typeof binding.port_ref === 'string';
}

function killSwitchOk(report, contract = {}) {
  const control = report.controls_current?.operator_kill_switch || {};
  const expected = preflightExpected(contract);
  return hasRequiredFields(control, expected.operatorKillSwitchRequiredFields || [])
    && control.visible === true
    && control.fail_closed === true
    && control.testable === true
    && control.wired_to_runtime_now === false
    && control.ignored_allowed === false;
}

function dryRunFallbackOk(report, contract = {}) {
  const fallback = report.controls_current?.dry_run_fallback || {};
  const expected = preflightExpected(contract);
  return hasRequiredFields(fallback, expected.dryRunFallbackRequiredFields || [])
    && fallback.preview_only === true
    && fallback.applies_when_flag_missing_false_invalid === true
    && fallback.bypass_allowed === false
    && fallback.tested_runtime_path_now === false;
}

function rollbackDisableOk(report, contract = {}) {
  const plan = report.controls_current?.rollback_disable_plan || {};
  const expected = preflightExpected(contract);
  return hasRequiredFields(plan, expected.rollbackDisableRequiredFields || [])
    && plan.disable_idempotent === true
    && plan.deletes_data === false
    && plan.resurrects_blocked_state === false
    && plan.rollback_exercised_now === false;
}

function telemetryAuditOk(report, contract = {}) {
  const plan = report.controls_current?.telemetry_audit_plan || {};
  const expected = preflightExpected(contract);
  return hasRequiredFields(plan, expected.telemetryAuditRequiredFields || [])
    && plan.redacted_preview_only === true
    && plan.store_write_now === false
    && plan.file_write_now === false
    && plan.db_write_now === false
    && plan.real_sink_wired_now === false
    && plan.raw_payload_allowed === false;
}

function portConfigOk(report, contract = {}) {
  const refs = report.controls_current?.port_config_refs || {};
  const expected = preflightExpected(contract);
  return hasRequiredFields(refs, expected.portConfigRefsRequiredFields || [])
    && refs.reference_only === true
    && typeof refs.port_ref === 'string'
    && typeof refs.storage_path_ref === 'string'
    && typeof refs.auth_secret_presence_ref === 'string'
    && typeof refs.key_ref === 'string'
    && refs.port_opened === false
    && refs.env_secret_read === false
    && refs.raw_secret_allowed === false
    && refs.raw_path_allowed === false;
}

function controlsCurrentOk(report, contract = {}) {
  const controls = report.controls_current || {};
  const expected = preflightExpected(contract);
  return hasRequiredFields(controls, expected.controlsCurrentRequiredFields || [])
    && controls.phase15_to_24_refs_reference_only === true
    && runtimeModeFlagOk(report, contract)
    && localBindingOk(report, contract)
    && killSwitchOk(report, contract)
    && dryRunFallbackOk(report, contract)
    && rollbackDisableOk(report, contract)
    && telemetryAuditOk(report, contract)
    && portConfigOk(report, contract);
}

function readinessDecisionOk(report, contract = {}) {
  const allowed = readinessDecisions(contract);
  const decision = report.readiness_decision;
  const candidate = report.candidate_runtime_slice || {};
  const flag = report.controls_current?.runtime_mode_flag || {};
  const eligibleSafe = decision !== 'eligible_for_future_local_dry_run_preflight'
    || (report.eligible_is_authorization === false
      && candidate.runtime_available_now === false
      && flag.runtime_started === false
      && sideEffectValuesOk(report.side_effect_result));
  return valuesMatch(report.readiness_decision_allowed_values, allowed)
    && allowed.includes(decision)
    && report.eligible_is_authorization === false
    && eligibleSafe;
}

function defaultDecisionOk(report, contract = {}) {
  return report.readiness_decision === (preflightExpected(contract).requiredDefaultDecision || 'remain_validation_only')
    && report.eligible_is_authorization === false;
}

function unsatisfiedGatesOk(report, contract = {}) {
  const gates = asArray(report.unsatisfied_gates);
  const requiredIds = requiredGateIds(contract);
  return gates.length === requiredIds.length
    && idsEqual(gates, 'gate_id', requiredIds)
    && gates.every((gate) => gate.status === 'unsatisfied'
      && gate.carried_forward === true
      && gate.blocks_runtime_now === true
      && asArray(gate.evidenceRefs).length > 0);
}

function proofBoundariesOk(report, contract = {}) {
  const proof = report.proof_boundaries || {};
  const expected = preflightExpected(contract);
  return hasRequiredFields(proof, expected.proofBoundaryRequiredFields || [])
    && proof.preflight_ready_is_runtime_proof === false
    && proof.config_present_is_runtime_proof === false
    && proof.socket_is_bridge_green_proof === false
    && proof.delivery_acceptance_is_model_processing_proof === false
    && proof.server_can_execute_local_arms === false
    && proof.builder_direct_server_target_allowed === false
    && proof.oracle_direct_server_target_allowed === false;
}

function blockedSideEffectsOk(report, contract = {}) {
  const effects = asArray(report.blocked_side_effects);
  const requiredIds = blockedSideEffectIds(contract);
  return effects.length === requiredIds.length
    && idsEqual(effects, 'effect_id', requiredIds)
    && effects.every((effect) => effect.blocked_now === true
      && Number(effect.attempts || 0) === 0
      && asArray(effect.evidenceRefs).length > 0)
    && sideEffectValuesOk(report.side_effect_result);
}

function tamperCoverageOk(report, contract = {}) {
  const fixtureCases = asArray(contract.tamperCases);
  const requiredIds = fixtureCases.length > 0
    ? fixtureCases.map((item) => item.id)
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

function unsafeActionDriftOk(report) {
  const unsafePattern = /\b(tier[234]|deploy|trade|money|send-to-customer|external send|memory commit|profile commit|capture|local execution|shell|pty)\b/i;
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
      throw new Error(`runtime_preflight_forbidden_substring:${forbidden}`);
    }
  }
}

function validatePreflightReport(report = {}, contract = {}) {
  const checks = [];
  const errors = [];
  const resultById = {};
  const add = (id, ok, detail = null, extra = {}) => {
    const result = resultObject(ok, detail, { id, ...extra });
    checks.push(result);
    resultById[id] = result;
    if (!ok && detail) errors.push(detail);
  };
  const expected = preflightExpected(contract);

  const phase25Ok = phase25DependencyOk(report, contract);
  const phase26Ok = phase26DependencyOk(report, contract);
  const candidateSafe = candidateOk(report, contract);
  const controlsOk = controlsCurrentOk(report, contract);
  const runtimeFlagSafe = runtimeModeFlagOk(report, contract);
  const bindingSafe = localBindingOk(report, contract);
  const killSwitchSafe = killSwitchOk(report, contract);
  const dryRunSafe = dryRunFallbackOk(report, contract);
  const rollbackSafe = rollbackDisableOk(report, contract);
  const telemetrySafe = telemetryAuditOk(report, contract);
  const portConfigSafe = portConfigOk(report, contract);
  const decisionSafe = readinessDecisionOk(report, contract);
  const defaultDecisionSafe = defaultDecisionOk(report, contract);
  const gatesSafe = unsatisfiedGatesOk(report, contract);
  const proofSafe = proofBoundariesOk(report, contract);
  const effectsSafe = blockedSideEffectsOk(report, contract);
  const tamperSafe = tamperCoverageOk(report, contract);
  const nextActionsSafe = nextSafeActionsOk(report, contract);
  const unsafeDriftSafe = unsafeActionDriftOk(report);

  add('output-shape-complete',
    report.schema === RUNTIME_PREFLIGHT_REPORT_SCHEMA_VERSION
      && hasRequiredFields(report, expected.requiredFields || REQUIRED_REPORT_FIELDS),
    'Runtime preflight report shape is incomplete.');
  add('phase25-baseline-3efa9c5-pinned', phase25Ok, 'Phase 25 dependency is missing or stale.');
  add('phase25-baseline-current', phase25Ok, 'Phase 25 baseline is not current.');
  add('stale-phase25-baseline-rejected', phase25Ok, 'Stale Phase 25 dependency was accepted.');
  add('phase26-baseline-b125eee-pinned', phase26Ok, 'Phase 26 dependency is missing or stale.');
  add('phase26-baseline-current', phase26Ok, 'Phase 26 baseline is not current.');
  add('stale-phase26-baseline-rejected', phase26Ok, 'Stale Phase 26 dependency was accepted.');
  add('candidate-remains-validation-only-unavailable', candidateSafe, 'Candidate runtime slice is overclaimed.');
  add('candidate-remains-non-authorizing-unavailable', candidateSafe, 'Candidate became available or authorizing.');
  add('phase26-controls-current-complete', controlsOk, 'Phase 26 controls are incomplete or unsafe.');
  add('controls-current-complete', controlsOk, 'Controls current surface is incomplete.');
  add('missing-controls-rejected', controlsOk, 'Missing controls were accepted.');
  add('runtime-flag-default-disabled-local-dev-visible-nonauthorizing', runtimeFlagSafe, 'Runtime flag is unsafe.');
  add('runtime-flag-default-disabled', runtimeFlagSafe, 'Runtime flag default is unsafe.');
  add('default-on-runtime-rejected', runtimeFlagSafe, 'Default-on runtime flag was accepted.');
  add('local-binding-loopback-only-no-listener-network', bindingSafe && portConfigSafe, 'Binding plan is unsafe.');
  add('local-binding-loopback-only', bindingSafe, 'Binding plan is not loopback-only.');
  add('non-loopback-binding-rejected', bindingSafe && portConfigSafe && sideEffectValuesOk(report.side_effect_result), 'Non-loopback binding or hidden network was accepted.');
  add('kill-switch-present-but-not-runtime-wired', killSwitchSafe, 'Kill switch is missing or overclaimed.');
  add('kill-switch-visible-fail-closed', killSwitchSafe, 'Kill switch is not fail-closed.');
  add('dry-run-fallback-preview-only-no-runtime-path', dryRunSafe, 'Dry-run fallback is unsafe.');
  add('dry-run-preview-only', dryRunSafe, 'Dry-run fallback is not preview-only.');
  add('rollback-disable-idempotent-no-delete-no-resurrection', rollbackSafe, 'Rollback/disable plan is unsafe.');
  add('rollback-disable-idempotent', rollbackSafe, 'Rollback/disable plan is not idempotent.');
  add('telemetry-audit-redacted-preview-only-no-writes', telemetrySafe, 'Telemetry/audit plan is unsafe.');
  add('telemetry-audit-preview-only', telemetrySafe, 'Telemetry/audit plan is not preview-only.');
  add('port-config-refs-reference-only-no-secret-path-leak', portConfigSafe, 'Port/config refs are unsafe.');
  add('port-config-reference-only', portConfigSafe, 'Port/config refs are not reference-only.');
  add('readiness-default-remain-validation-only', defaultDecisionSafe, 'Default readiness decision changed.');
  add('readiness-decision-default-remain-validation-only', defaultDecisionSafe, 'Default readiness decision is not validation-only.');
  add('eligible-preflight-is-non-authorizing', decisionSafe, 'Eligible readiness was treated as authorization.');
  add('eligible-decision-non-authorizing', decisionSafe, 'Eligible decision is authorizing or unsafe.');
  add('unsatisfied-gates-carried-forward', gatesSafe, 'Unsatisfied gates are incomplete.');
  add('unsatisfied-gates-present', gatesSafe, 'Unsatisfied gates are missing.');
  add('missing-unsatisfied-gates-rejected', gatesSafe, 'Missing unsatisfied gates were accepted.');
  add('proof-boundaries-preserved', proofSafe, 'Proof boundary was overclaimed.');
  add('fake-proof-rejected', proofSafe, 'Fake runtime/model/bridge proof was accepted.');
  add('direct-builder-oracle-server-targets-blocked',
    report.proof_boundaries?.builder_direct_server_target_allowed === false
      && report.proof_boundaries?.oracle_direct_server_target_allowed === false,
    'Direct Builder/Oracle server targets were accepted.');
  add('direct-builder-oracle-targets-blocked',
    report.proof_boundaries?.builder_direct_server_target_allowed === false
      && report.proof_boundaries?.oracle_direct_server_target_allowed === false,
    'Direct Builder/Oracle target flags are unsafe.');
  add('side-effects-blocked-now', effectsSafe, 'Blocked side effects or side-effect truth changed.');
  add('side-effect-truth-all-blocked', effectsSafe, 'Side-effect truth is unsafe.');

  try {
    assertNoForbiddenOutput(report, asArray(contract.forbiddenOutputSubstrings));
    add('raw-private-secret-leakage-rejected', true, null);
    add('raw-secret-path-leak-rejected', true, null);
  } catch (err) {
    add('raw-private-secret-leakage-rejected', false, err.message);
    add('raw-secret-path-leak-rejected', false, err.message);
  }

  add('unsafe-action-drift-rejected',
    nextActionsSafe && unsafeDriftSafe,
    'Unsafe action drift was accepted.');
  add('tamper-coverage-complete', tamperSafe, 'Tamper coverage is incomplete.');
  add('next-safe-actions-complete', nextActionsSafe, 'Next safe actions are incomplete.');
  add('idempotency-sensitive-to-preflight-inputs',
    report.idempotency_key === runtimePreflightIdempotencyKey(report),
    'Runtime preflight idempotency key is unstable.');
  add('idempotency-sensitive-to-baselines-controls-gates',
    report.idempotency_key === runtimePreflightIdempotencyKey(report),
    'Runtime preflight idempotency did not reflect preflight inputs.');
  add('report-literal-values',
    literalValuesOk(report, expected.requiredLiteralValues || {}),
    'Runtime preflight literal values changed.');

  return {
    ok: errors.length === 0,
    checks,
    errors,
    resultById,
  };
}

function buildValidationReport(preflightReport, contract = {}, generatedAt = preflightReport.generated_at) {
  const validation = validatePreflightReport(preflightReport, contract);
  const failed = validation.checks.filter((check) => !check.ok);
  const checkResult = (id) => validation.resultById[id] || resultObject(false, `${id} missing`);
  const report = {
    schema: VALIDATION_REPORT_SCHEMA_VERSION,
    version: RUNTIME_PREFLIGHT_VERSION,
    report_id: `runtime-preflight-validation-${stableHash({
      preflight_key: preflightReport.idempotency_key,
      generatedAt,
    }).slice(0, 12)}`,
    generated_at: generatedAt,
    baseline_commit: BASELINE_COMMIT,
    decision: validation.ok ? 'accepted' : 'blocked',
    reasons: failed.map((check) => check.id),
    phase25_dependency_result: checkResult('phase25-baseline-current'),
    phase26_dependency_result: checkResult('phase26-baseline-current'),
    candidate_result: checkResult('candidate-remains-non-authorizing-unavailable'),
    controls_current_result: checkResult('controls-current-complete'),
    readiness_decision_result: checkResult('readiness-decision-default-remain-validation-only'),
    unsatisfied_gates_result: checkResult('unsatisfied-gates-present'),
    proof_boundary_result: checkResult('proof-boundaries-preserved'),
    side_effect_result: sideEffectResult(),
    acceptance_checks: asArray(contract.acceptanceChecks).map((check) => ({
      id: check.id,
      ok: Boolean(validation.resultById[check.id]?.ok),
    })),
    failed_checks: failed.map((check) => check.id),
    evidenceRefs: [
      evidenceRef('mira-core-runtime-preflight', 'phase27-validation-report'),
    ],
  };
  assertNoForbiddenOutput(report, asArray(contract.forbiddenOutputSubstrings));
  return report;
}

function buildMiraCoreRuntimePreflight(options = {}) {
  const contract = options.contract || {};
  const preflightReport = buildPreflightReport(options);
  const validation_report = buildValidationReport(preflightReport, contract, preflightReport.generated_at);
  const output = {
    runtime_preflight_report: preflightReport,
    validation_report,
  };
  assertNoForbiddenOutput(output, asArray(contract.forbiddenOutputSubstrings));
  return output;
}

function validateMiraCoreRuntimePreflightOutput(output = {}, contract = {}) {
  const checks = [];
  const errors = [];
  const add = (id, ok, detail = null) => {
    checks.push({ id, ok: ok === true, detail });
    if (!ok && detail) errors.push(detail);
  };
  const preflightReport = output.runtime_preflight_report || {};
  const validationReport = output.validation_report || {};
  const preflightValidation = validatePreflightReport(preflightReport, contract);
  const acceptanceIds = asArray(contract.acceptanceChecks).map((check) => check.id);

  add('output-shape-complete',
    hasRequiredFields(output, contract.expectedOutputShape?.requiredTopLevelFields || REQUIRED_OUTPUT_FIELDS)
      && preflightReport.schema === RUNTIME_PREFLIGHT_REPORT_SCHEMA_VERSION
      && validationReport.schema === VALIDATION_REPORT_SCHEMA_VERSION
      && hasRequiredFields(preflightReport, contract.expectedRuntimePreflightReportShape?.requiredFields || REQUIRED_REPORT_FIELDS)
      && hasRequiredFields(validationReport, contract.expectedValidationReportShape?.requiredFields || REQUIRED_VALIDATION_REPORT_FIELDS),
    'Runtime preflight output shape is incomplete.');

  for (const check of preflightValidation.checks) add(check.id, check.ok, check.detail);

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
  CANDIDATE_SLICE_ID,
  DEFAULT_BLOCKED_SIDE_EFFECT_IDS,
  DEFAULT_NEXT_SAFE_ACTION_IDS,
  DEFAULT_READINESS_DECISIONS,
  DEFAULT_TAMPER_CASE_IDS,
  DEFAULT_UNSATISFIED_GATE_IDS,
  PHASE25_COMMIT,
  REQUIRED_OUTPUT_FIELDS,
  REQUIRED_REPORT_FIELDS,
  REQUIRED_SIDE_EFFECT_FIELDS,
  REQUIRED_VALIDATION_REPORT_FIELDS,
  RUNTIME_PREFLIGHT_REPORT_SCHEMA_VERSION,
  VALIDATION_REPORT_SCHEMA_VERSION,
  assertNoForbiddenOutput,
  buildMiraCoreRuntimePreflight,
  runtimePreflightIdempotencyKey,
  stableHash,
  validateMiraCoreRuntimePreflightOutput,
};
