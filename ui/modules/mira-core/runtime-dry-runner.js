'use strict';

const crypto = require('crypto');

const RUNTIME_DRY_RUNNER_REPORT_SCHEMA_VERSION = 'squidrun.mira_core.runtime_dry_runner_contract_report.v0';
const VALIDATION_REPORT_SCHEMA_VERSION = 'squidrun.mira_core.runtime_dry_runner_validation_report.v0';
const RUNTIME_DRY_RUNNER_VERSION = 'v0';
const BASELINE_COMMIT = '83963ab';
const RUNNER_ID = 'runtime_slice_0_disabled_local_dry_runner_contract';

const REQUIRED_OUTPUT_FIELDS = Object.freeze([
  'runtime_dry_runner_contract_report',
  'validation_report',
]);

const REQUIRED_REPORT_FIELDS = Object.freeze([
  'schema',
  'version',
  'runner_contract_id',
  'idempotency_key',
  'generated_at',
  'profile',
  'sessionId',
  'deviceId',
  'baseline_commit',
  'phase_31_dependency',
  'runner_id',
  'runner_status',
  'runner_decision',
  'runner_decision_allowed_values',
  'eligible_is_authorization',
  'eligible_is_runtime_proof',
  'runtime_available_now',
  'runtime_started',
  'runner_available_now',
  'runner_executed',
  'runtime_mode_flag_dependency',
  'kill_switch_dependency',
  'runner_request_contract',
  'runner_response_contract',
  'dry_run_result_enums',
  'idempotency_replay_rules',
  'local_in_process_boundary',
  'operator_visible_status',
  'telemetry_audit_preview',
  'rollback_disable_boundaries',
  'proof_boundaries',
  'target_boundaries',
  'unsafe_action_policy',
  'blocked_side_effects',
  'phase31_registry_carry_forward',
  'next_phase_recommendations',
  'evidenceRefs',
  'side_effect_result',
]);

const REQUIRED_VALIDATION_REPORT_FIELDS = Object.freeze([
  'schema',
  'version',
  'fixture_ref',
  'baseline_commit',
  'accepted',
  'decision',
  'reasons',
  'checks',
  'phase31_dependency_result',
  'runner_contract_result',
  'request_response_contract_result',
  'result_enum_result',
  'idempotency_replay_result',
  'side_effect_result',
  'proof_boundary_result',
  'unsafe_action_result',
  'evidenceRefs',
]);

const REQUIRED_SIDE_EFFECT_FIELDS = Object.freeze([
  'no_runtime_performed',
  'no_runner_executed',
  'no_server_performed',
  'no_listener_or_route_bound',
  'no_network_performed',
  'no_database_write_performed',
  'no_store_write_performed',
  'no_file_write_performed',
  'no_audit_write_performed',
  'no_telemetry_write_performed',
  'no_migration_executed',
  'no_queue_created',
  'no_lease_created',
  'no_auth_change_performed',
  'no_key_secret_operation_performed',
  'no_local_execution_performed',
  'no_shell_or_pty_performed',
  'no_send_performed',
  'no_deploy_performed',
  'no_trade_performed',
  'no_output_file_written',
]);

const SIDE_EFFECT_REQUIRED_FALSE_FIELDS = Object.freeze([
  'runtimeStarted',
  'runnerExecuted',
  'serverStarted',
]);

const SIDE_EFFECT_REQUIRED_ZERO_FIELDS = Object.freeze([
  'listenersBound',
  'networkCallsMade',
  'filesWritten',
  'auditWrites',
  'telemetryWrites',
  'outputFilesWritten',
]);

const DEFAULT_FORBIDDEN_OUTPUT_SUBSTRINGS = Object.freeze([
  'bearer token',
  'api key',
  'private key',
  'data key',
  'session secret',
  'env secret',
  'raw terminal',
  'terminal scrollback',
  'raw screenshot',
  'raw OCR',
  'browser cookie',
  'browser DOM',
  'customer private',
  'side profile payload',
  'decrypted payload',
  'raw comms body',
  'runtime started',
  'runner executed',
  'server started',
  'listener bound',
  'network request sent',
  'database write',
  'store write',
  'file written',
  'audit write',
  'telemetry write',
  'output file written',
  'queue created',
  'lease created',
  'local execution performed',
  'shell executed',
  'PTY executed',
  'customer send performed',
  'external send performed',
  'deploy performed',
  'trade performed',
  'runtime is available',
  'runner is available',
  'socket proves bridge green',
  'delivery acceptance proves model processing',
  'Builder direct target allowed',
  'Oracle direct target allowed',
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

function evidenceRef(store, eventId, relation = 'runtime_dry_runner_validation') {
  return { store, eventId, relation };
}

function resultObject(id, ok) {
  return { id, ok: ok === true };
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

function dryRunnerExpected(contract = {}) {
  return contract.expectedRuntimeDryRunnerContractReportShape || {};
}

function runnerDecisionValues(contract = {}) {
  return asArray(dryRunnerExpected(contract).runnerDecisionAllowedValues).length > 0
    ? dryRunnerExpected(contract).runnerDecisionAllowedValues
    : [
      'remain_disabled_dry_runner_contract_only',
      'blocked',
      'eligible_for_future_disabled_local_dry_runner_validation_slice',
    ];
}

function dryRunResultValues(contract = {}) {
  return asArray(dryRunnerExpected(contract).dryRunResultAllowedValues);
}

function blockedSideEffectIds(contract = {}) {
  return asArray(dryRunnerExpected(contract).blockedSideEffectsExpected);
}

function sideEffectResult() {
  return {
    no_runtime_performed: true,
    no_runner_executed: true,
    no_server_performed: true,
    no_listener_or_route_bound: true,
    no_network_performed: true,
    no_database_write_performed: true,
    no_store_write_performed: true,
    no_file_write_performed: true,
    no_audit_write_performed: true,
    no_telemetry_write_performed: true,
    no_migration_executed: true,
    no_queue_created: true,
    no_lease_created: true,
    no_auth_change_performed: true,
    no_key_secret_operation_performed: true,
    no_local_execution_performed: true,
    no_shell_or_pty_performed: true,
    no_send_performed: true,
    no_deploy_performed: true,
    no_trade_performed: true,
    no_output_file_written: true,
    runtimeStarted: false,
    runnerExecuted: false,
    serverStarted: false,
    listenersBound: 0,
    networkCallsMade: 0,
    filesWritten: 0,
    auditWrites: 0,
    telemetryWrites: 0,
    outputFilesWritten: 0,
  };
}

function phase31Dependency(contract = {}) {
  return {
    phase: 'phase_31_runtime_control_path_readiness_milestone_refresh_contract',
    commit: BASELINE_COMMIT,
    fixture_path: 'ui/__tests__/fixtures/mira-core-runtime-milestone-refresh-contract.json',
    module_path: 'ui/modules/mira-core/runtime-milestone-refresh.js',
    cli_path: 'ui/scripts/hm-mira-core-runtime-milestone-refresh.js',
    test_path: 'ui/__tests__/mira-core-runtime-milestone-refresh.test.js',
    status: 'committed_validation_only',
    default_decision: 'accepted_validation_only',
    phase_registry_count: 30,
    schema_registry_count: 30,
    cli_registry_count: 30,
    commit_chain_count: 19,
    phase23_stale_superseded: true,
    phase30_oracle_115_closure: true,
    commit_chain_through_phase31: clone(dryRunnerExpected(contract).phase31CommitChainExpected || []),
    evidenceRefs: [
      evidenceRef('git', BASELINE_COMMIT, 'phase31-commit'),
      evidenceRef('mira-core-runtime-milestone-refresh', 'phase31-dependency'),
    ],
  };
}

function runtimeModeFlagDependency() {
  return {
    flag_id: 'MIRA_CORE_RUNTIME_DRY_RUN_MODE',
    required: true,
    default_state: 'disabled',
    default_enabled: false,
    dev_only: true,
    local_only: true,
    non_authorizing: true,
    runner_starts_when_present: false,
    evidenceRefs: [
      evidenceRef('mira-core-runtime-dry-runner', 'runtime-mode-flag-dependency'),
    ],
  };
}

function killSwitchDependency() {
  return {
    required: true,
    default_state: 'engaged',
    fail_closed: true,
    testable: true,
    ignored_allowed: false,
    authorizes_runtime: false,
    evidenceRefs: [
      evidenceRef('mira-core-runtime-dry-runner', 'kill-switch-dependency'),
    ],
  };
}

function requestExample(scope) {
  const payloadHash = stableHash({
    payload_summary: 'Redacted status preview request.',
    profile: scope.profile.name,
    sessionId: scope.sessionId,
    deviceId: scope.deviceId,
  });
  return {
    schema: 'squidrun.mira_core.runtime_dry_runner_request.v0',
    request_id: 'dry-runner-request-example',
    idempotency_key: `dry-runner-request:${payloadHash.slice(0, 16)}`,
    replay_key: `dry-runner-replay:${payloadHash.slice(0, 16)}`,
    profile: clone(scope.profile),
    sessionId: scope.sessionId,
    deviceId: scope.deviceId,
    risk_tier: 'Tier0',
    action_class: 'status_preview',
    payload_summary: 'Redacted status preview request.',
    payload_hash: payloadHash,
    payload_redaction_status: 'redacted',
    source_refs: ['phase32-runtime-dry-runner-contract'],
    evidenceRefs: [
      evidenceRef('mira-core-runtime-dry-runner', 'request-example'),
    ],
    expires_at: '2099-01-01T00:00:00.000Z',
  };
}

function runnerRequestContract(contract = {}, scope) {
  const expected = dryRunnerExpected(contract);
  return {
    schema: 'squidrun.mira_core.runtime_dry_runner_request.v0',
    validation_only: true,
    local_in_process_only: true,
    requires_idempotency_key: true,
    requires_replay_key: true,
    redacted_payload_only: true,
    allows_raw_payload: false,
    allows_queue_or_lease: false,
    allows_local_execution: false,
    required_fields: clone(expected.runnerRequestRequiredFields || []),
    allowed_risk_tiers: clone(expected.runnerRequestAllowedRiskTiers || ['Tier0', 'Tier1']),
    payload_summary_example: 'Redacted status preview request.',
    request_example: requestExample(scope),
    evidenceRefs: [
      evidenceRef('mira-core-runtime-dry-runner', 'runner-request-contract'),
    ],
  };
}

function runnerResponseContract(contract = {}) {
  const expected = dryRunnerExpected(contract);
  return {
    schema: 'squidrun.mira_core.runtime_dry_runner_response.v0',
    status_preview_only: true,
    executes_request: false,
    starts_runtime: false,
    creates_queue_or_lease: false,
    writes_store_file_db_or_audit: false,
    authorizes_runtime: false,
    required_fields: clone(expected.runnerResponseRequiredFields || []),
    response_example: {
      schema: 'squidrun.mira_core.runtime_dry_runner_response.v0',
      request_id: 'dry-runner-request-example',
      runner_id: RUNNER_ID,
      decision: 'blocked',
      result: 'blocked_disabled_contract_only',
      result_reason: 'disabled_contract_only',
      status_preview: {
        status: 'blocked_disabled_contract_only',
        operator_visible: true,
      },
      side_effect_result: sideEffectResult(),
      proof_boundaries: proofBoundaries(),
      evidenceRefs: [
        evidenceRef('mira-core-runtime-dry-runner', 'response-example'),
      ],
    },
    evidenceRefs: [
      evidenceRef('mira-core-runtime-dry-runner', 'runner-response-contract'),
    ],
  };
}

function dryRunResultEnums(contract = {}) {
  return {
    allowed_results: clone(dryRunResultValues(contract)),
    default_result: 'blocked_disabled_contract_only',
    result_values_authorize_runtime: false,
    evidenceRefs: [
      evidenceRef('mira-core-runtime-dry-runner', 'dry-run-result-enums'),
    ],
  };
}

function idempotencyReplayRules() {
  return {
    idempotency_required: true,
    replay_key_required: true,
    same_request_same_key: true,
    payload_or_scope_change_changes_key: true,
    replay_executes_side_effects: false,
    stale_request_rejected: true,
    evidenceRefs: [
      evidenceRef('mira-core-runtime-dry-runner', 'idempotency-replay-rules'),
    ],
  };
}

function localInProcessBoundary() {
  return {
    in_process_only: true,
    loopback_only_if_future_transport: true,
    public_interface_allowed: false,
    remote_interface_allowed: false,
    listener_opened_now: false,
    network_performed_now: false,
    evidenceRefs: [
      evidenceRef('mira-core-runtime-dry-runner', 'local-in-process-boundary'),
    ],
  };
}

function operatorVisibleStatus() {
  return {
    visible: true,
    status_only: true,
    includes_disabled_flag: true,
    includes_kill_switch: true,
    includes_proof_truth: true,
    authorizes_runtime: false,
    summary: 'Disabled contract status preview only.',
    evidenceRefs: [
      evidenceRef('mira-core-runtime-dry-runner', 'operator-visible-status'),
    ],
  };
}

function telemetryAuditPreview() {
  return {
    redacted_preview_only: true,
    raw_payload_allowed: false,
    telemetry_sink_reference_only: true,
    audit_sink_reference_only: true,
    telemetry_write_now: false,
    audit_write_now: false,
    file_write_now: false,
    db_write_now: false,
    preview_summary: 'Redacted preview metadata only.',
    evidenceRefs: [
      evidenceRef('mira-core-runtime-dry-runner', 'telemetry-audit-preview'),
    ],
  };
}

function rollbackDisableBoundaries() {
  return {
    disable_idempotent: true,
    rollback_preview_only: true,
    rollback_executed_now: false,
    deletes_data: false,
    resurrects_blocked_state: false,
    authorizes_runtime: false,
    evidenceRefs: [
      evidenceRef('mira-core-runtime-dry-runner', 'rollback-disable-boundaries'),
    ],
  };
}

function proofBoundaries() {
  return {
    runtime_flag_is_runtime_proof: false,
    kill_switch_check_is_runtime_proof: false,
    runner_contract_is_runtime_proof: false,
    dry_run_response_is_execution_proof: false,
    socket_is_bridge_green_proof: false,
    delivery_acceptance_is_model_processing_proof: false,
    serverCanExecuteLocal: false,
    server_can_execute_local_arms: false,
    evidenceRefs: [
      evidenceRef('mira-core-runtime-dry-runner', 'proof-boundaries'),
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
      evidenceRef('mira-core-runtime-dry-runner', 'target-boundaries'),
    ],
  };
}

function unsafeActionPolicy(contract = {}) {
  return {
    ...clone(dryRunnerExpected(contract).unsafeActionPolicyRequiredValues || {}),
    evidenceRefs: [
      evidenceRef('mira-core-runtime-dry-runner', 'unsafe-action-policy'),
    ],
  };
}

function blockedSideEffects(contract = {}) {
  return blockedSideEffectIds(contract).map((effectId) => ({
    effect_id: effectId,
    blocked_now: true,
    attempts: 0,
    evidenceRefs: [
      evidenceRef('mira-core-runtime-dry-runner', `blocked-effect:${effectId}`),
    ],
  }));
}

function phase31RegistryCarryForward() {
  return {
    phase_inventory_count: 30,
    schema_registry_count: 30,
    cli_registry_count: 30,
    commit_chain_count: 19,
    phase23_stale_superseded: true,
    phase30_oracle_115_closure: true,
    evidenceRefs: [
      evidenceRef('mira-core-runtime-dry-runner', 'phase31-registry-carry-forward'),
    ],
  };
}

function nextPhaseRecommendations(contract = {}) {
  return asArray(dryRunnerExpected(contract).nextRecommendationExpectedCandidates).map((candidate) => ({
    ...clone(candidate),
    why_safe: 'It is validation metadata for a disabled local preview path.',
    blocked_side_effects: [
      'runtime',
      'runner-execution',
      'network',
      'persistent-mutation',
      'external-action',
    ],
    prerequisites: [
      'Phase 32 accepted',
      'Operator review before any future local validation slice',
    ],
    evidenceRefs: [
      evidenceRef('mira-core-runtime-dry-runner', `next:${candidate.recommendation_id}`),
    ],
  }));
}

function canonicalReportInput(report) {
  return {
    profile: report.profile,
    sessionId: report.sessionId,
    deviceId: report.deviceId,
    baseline_commit: report.baseline_commit,
    phase_31_dependency: report.phase_31_dependency,
    runner_id: report.runner_id,
    runner_status: report.runner_status,
    runner_decision: report.runner_decision,
    runner_decision_allowed_values: report.runner_decision_allowed_values,
    eligible_is_authorization: report.eligible_is_authorization,
    eligible_is_runtime_proof: report.eligible_is_runtime_proof,
    requires_future_review: report.requires_future_review,
    requires_operator_review: report.requires_operator_review,
    runtime_available_now: report.runtime_available_now,
    runtime_started: report.runtime_started,
    runner_available_now: report.runner_available_now,
    runner_executed: report.runner_executed,
    runtime_mode_flag_dependency: report.runtime_mode_flag_dependency,
    kill_switch_dependency: report.kill_switch_dependency,
    runner_request_contract: report.runner_request_contract,
    runner_response_contract: report.runner_response_contract,
    dry_run_result_enums: report.dry_run_result_enums,
    idempotency_replay_rules: report.idempotency_replay_rules,
    local_in_process_boundary: report.local_in_process_boundary,
    operator_visible_status: report.operator_visible_status,
    telemetry_audit_preview: report.telemetry_audit_preview,
    rollback_disable_boundaries: report.rollback_disable_boundaries,
    proof_boundaries: report.proof_boundaries,
    target_boundaries: report.target_boundaries,
    unsafe_action_policy: report.unsafe_action_policy,
    blocked_side_effects: report.blocked_side_effects,
    phase31_registry_carry_forward: report.phase31_registry_carry_forward,
    next_phase_recommendations: report.next_phase_recommendations,
    side_effect_result: report.side_effect_result,
  };
}

function runtimeDryRunnerIdempotencyKey(report) {
  return `runtime-dry-runner:${stableHash(canonicalReportInput(report))}`;
}

function buildRuntimeDryRunnerContractReport(options = {}) {
  const contract = options.contract || {};
  const inputSignals = options.inputSignals || {};
  const scope = normalizeScope(inputSignals);
  const generatedAt = generatedAtFromOptions(options, inputSignals);
  const report = {
    schema: RUNTIME_DRY_RUNNER_REPORT_SCHEMA_VERSION,
    version: RUNTIME_DRY_RUNNER_VERSION,
    runner_contract_id: null,
    idempotency_key: null,
    generated_at: generatedAt,
    profile: scope.profile,
    sessionId: scope.sessionId,
    deviceId: scope.deviceId,
    baseline_commit: inputSignals.baseline_commit || BASELINE_COMMIT,
    phase_31_dependency: phase31Dependency(contract),
    runner_id: RUNNER_ID,
    runner_status: 'contract_ready_validation_only',
    runner_decision: inputSignals.runnerDecision || 'remain_disabled_dry_runner_contract_only',
    runner_decision_allowed_values: clone(runnerDecisionValues(contract)),
    eligible_is_authorization: false,
    eligible_is_runtime_proof: false,
    requires_future_review: true,
    requires_operator_review: true,
    runtime_available_now: false,
    runtime_started: false,
    runner_available_now: false,
    runner_executed: false,
    runtime_mode_flag_dependency: runtimeModeFlagDependency(),
    kill_switch_dependency: killSwitchDependency(),
    runner_request_contract: runnerRequestContract(contract, scope),
    runner_response_contract: runnerResponseContract(contract),
    dry_run_result_enums: dryRunResultEnums(contract),
    idempotency_replay_rules: idempotencyReplayRules(),
    local_in_process_boundary: localInProcessBoundary(),
    operator_visible_status: operatorVisibleStatus(),
    telemetry_audit_preview: telemetryAuditPreview(),
    rollback_disable_boundaries: rollbackDisableBoundaries(),
    proof_boundaries: proofBoundaries(),
    target_boundaries: targetBoundaries(),
    unsafe_action_policy: unsafeActionPolicy(contract),
    blocked_side_effects: blockedSideEffects(contract),
    phase31_registry_carry_forward: phase31RegistryCarryForward(),
    next_phase_recommendations: nextPhaseRecommendations(contract),
    evidenceRefs: [
      evidenceRef('git', BASELINE_COMMIT, 'phase32-baseline'),
      evidenceRef('mira-core-runtime-dry-runner-contract', 'phase32-contract'),
    ],
    side_effect_result: sideEffectResult(),
  };
  report.idempotency_key = runtimeDryRunnerIdempotencyKey(report);
  report.runner_contract_id = `runtime-dry-runner-${stableHash({
    key: report.idempotency_key,
    generatedAt,
  }).slice(0, 12)}`;
  assertNoForbiddenOutput(report, asArray(contract.forbiddenOutputSubstrings));
  return report;
}

function literalValuesOk(value, literals = {}) {
  return Object.entries(literals || {}).every(([field, expected]) => valuesMatch(pathValue(value, field), expected));
}

function sideEffectValuesOk(value = {}) {
  return REQUIRED_SIDE_EFFECT_FIELDS.every((field) => value[field] === true)
    && SIDE_EFFECT_REQUIRED_FALSE_FIELDS.every((field) => value[field] === false)
    && SIDE_EFFECT_REQUIRED_ZERO_FIELDS.every((field) => Number(value[field] || 0) === 0);
}

function phase31DependencyOk(report, contract = {}) {
  const expected = dryRunnerExpected(contract);
  const dependency = report.phase_31_dependency || {};
  const chain = asArray(dependency.commit_chain_through_phase31);
  return hasRequiredFields(dependency, expected.phase31DependencyRequiredFields || [])
    && literalValuesOk(dependency, expected.phase31DependencyRequiredValues || {})
    && valuesMatch(chain, expected.phase31CommitChainExpected || [])
    && chain.length === 19
    && asArray(dependency.evidenceRefs).length > 0;
}

function registryCarryOk(report) {
  const carry = report.phase31_registry_carry_forward || {};
  return carry.phase_inventory_count === 30
    && carry.schema_registry_count === 30
    && carry.cli_registry_count === 30
    && carry.commit_chain_count === 19
    && carry.phase23_stale_superseded === true
    && carry.phase30_oracle_115_closure === true
    && asArray(carry.evidenceRefs).length > 0;
}

function runnerContractOk(report, contract = {}) {
  const expected = dryRunnerExpected(contract);
  const decisionAllowed = runnerDecisionValues(contract);
  const eligibleValues = expected.eligibleDecisionRequiredValues || {};
  return report.runner_id === RUNNER_ID
    && report.runner_status === 'contract_ready_validation_only'
    && report.runner_decision === 'remain_disabled_dry_runner_contract_only'
    && valuesMatch(report.runner_decision_allowed_values, decisionAllowed)
    && Object.entries(eligibleValues).every(([field, value]) => valuesMatch(report[field], value))
    && report.eligible_is_authorization === false
    && report.eligible_is_runtime_proof === false
    && report.runtime_available_now === false
    && report.runtime_started === false
    && report.runner_available_now === false
    && report.runner_executed === false;
}

function flagKillSwitchOk(report) {
  const flag = report.runtime_mode_flag_dependency || {};
  const kill = report.kill_switch_dependency || {};
  return flag.flag_id === 'MIRA_CORE_RUNTIME_DRY_RUN_MODE'
    && flag.required === true
    && flag.default_state === 'disabled'
    && flag.default_enabled === false
    && flag.dev_only === true
    && flag.local_only === true
    && flag.non_authorizing === true
    && flag.runner_starts_when_present === false
    && kill.required === true
    && kill.default_state === 'engaged'
    && kill.fail_closed === true
    && kill.testable === true
    && kill.ignored_allowed === false
    && kill.authorizes_runtime === false;
}

function requestContractOk(report, contract = {}) {
  const request = report.runner_request_contract || {};
  const expected = dryRunnerExpected(contract);
  const example = request.request_example || {};
  const riskTiers = asArray(expected.runnerRequestAllowedRiskTiers);
  const expiresAtMs = Date.parse(example.expires_at || '');
  const generatedAtMs = Date.parse(report.generated_at || '');
  const expiryFresh = Number.isFinite(expiresAtMs)
    && Number.isFinite(generatedAtMs)
    && expiresAtMs >= generatedAtMs;
  return request.schema === 'squidrun.mira_core.runtime_dry_runner_request.v0'
    && request.validation_only === true
    && request.local_in_process_only === true
    && request.requires_idempotency_key === true
    && request.requires_replay_key === true
    && request.redacted_payload_only === true
    && request.allows_raw_payload === false
    && request.allows_queue_or_lease === false
    && request.allows_local_execution === false
    && valuesMatch(asArray(request.required_fields), asArray(expected.runnerRequestRequiredFields))
    && hasRequiredFields(example, expected.runnerRequestRequiredFields || [])
    && riskTiers.includes(example.risk_tier)
    && example.payload_redaction_status === 'redacted'
    && typeof example.payload_hash === 'string'
    && expiryFresh
    && asArray(example.evidenceRefs).length > 0;
}

function responseContractOk(report, contract = {}) {
  const response = report.runner_response_contract || {};
  const expected = dryRunnerExpected(contract);
  const example = response.response_example || {};
  return response.schema === 'squidrun.mira_core.runtime_dry_runner_response.v0'
    && response.status_preview_only === true
    && response.executes_request === false
    && response.starts_runtime === false
    && response.creates_queue_or_lease === false
    && response.writes_store_file_db_or_audit === false
    && response.authorizes_runtime === false
    && valuesMatch(asArray(response.required_fields), asArray(expected.runnerResponseRequiredFields))
    && hasRequiredFields(example, expected.runnerResponseRequiredFields || [])
    && example.runner_id === RUNNER_ID
    && dryRunResultValues(contract).includes(example.result)
    && sideEffectValuesOk(example.side_effect_result)
    && proofBoundaryOk({ proof_boundaries: example.proof_boundaries }, contract);
}

function resultEnumsOk(report, contract = {}) {
  const results = report.dry_run_result_enums || {};
  const expected = dryRunResultValues(contract);
  return valuesMatch(asArray(results.allowed_results), expected)
    && asArray(results.allowed_results).length === 12
    && results.default_result === 'blocked_disabled_contract_only'
    && results.result_values_authorize_runtime === false;
}

function idempotencyReplayOk(report) {
  const rules = report.idempotency_replay_rules || {};
  return rules.idempotency_required === true
    && rules.replay_key_required === true
    && rules.same_request_same_key === true
    && rules.payload_or_scope_change_changes_key === true
    && rules.replay_executes_side_effects === false
    && rules.stale_request_rejected === true;
}

function localBoundaryOk(report) {
  const boundary = report.local_in_process_boundary || {};
  return boundary.in_process_only === true
    && boundary.loopback_only_if_future_transport === true
    && boundary.public_interface_allowed === false
    && boundary.remote_interface_allowed === false
    && boundary.listener_opened_now === false
    && boundary.network_performed_now === false;
}

function operatorStatusOk(report) {
  const status = report.operator_visible_status || {};
  return status.visible === true
    && status.status_only === true
    && status.includes_disabled_flag === true
    && status.includes_kill_switch === true
    && status.includes_proof_truth === true
    && status.authorizes_runtime === false;
}

function telemetryOk(report) {
  const telemetry = report.telemetry_audit_preview || {};
  return telemetry.redacted_preview_only === true
    && telemetry.raw_payload_allowed === false
    && telemetry.telemetry_sink_reference_only === true
    && telemetry.audit_sink_reference_only === true
    && telemetry.telemetry_write_now === false
    && telemetry.audit_write_now === false
    && telemetry.file_write_now === false
    && telemetry.db_write_now === false;
}

function rollbackOk(report) {
  const rollback = report.rollback_disable_boundaries || {};
  return rollback.disable_idempotent === true
    && rollback.rollback_preview_only === true
    && rollback.rollback_executed_now === false
    && rollback.deletes_data === false
    && rollback.resurrects_blocked_state === false
    && rollback.authorizes_runtime === false;
}

function proofBoundaryOk(report, contract = {}) {
  const proof = report.proof_boundaries || {};
  const expected = dryRunnerExpected(contract);
  return hasRequiredFields(proof, [
    'runtime_flag_is_runtime_proof',
    'kill_switch_check_is_runtime_proof',
    'runner_contract_is_runtime_proof',
    'dry_run_response_is_execution_proof',
    'socket_is_bridge_green_proof',
    'delivery_acceptance_is_model_processing_proof',
    'serverCanExecuteLocal',
    'server_can_execute_local_arms',
  ])
    && literalValuesOk({ proof_boundaries: proof }, Object.fromEntries(
      Object.entries(expected.requiredLiteralValues || {})
        .filter(([field]) => field.startsWith('proof_boundaries.')),
    ));
}

function targetBoundaryOk(report) {
  const target = report.target_boundaries || {};
  return target.allowed_server_originated_target === 'architect'
    && target.builder_direct_server_target_allowed === false
    && target.oracle_direct_server_target_allowed === false
    && target.local_architect_acceptance_required === true;
}

function unsafeActionPolicyOk(report, contract = {}) {
  const policy = report.unsafe_action_policy || {};
  return Object.entries(dryRunnerExpected(contract).unsafeActionPolicyRequiredValues || {})
    .every(([field, value]) => valuesMatch(policy[field], value));
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

function nextRecommendationsOk(report, contract = {}) {
  const expected = dryRunnerExpected(contract);
  const allowedTiers = asArray(expected.nextRecommendationAllowedTiers);
  const recommendations = asArray(report.next_phase_recommendations);
  return recommendations.length === asArray(expected.nextRecommendationExpectedCandidates).length
    && asArray(expected.nextRecommendationExpectedCandidates).every((candidate) => recommendations.some((recommendation) => (
      recommendation.recommendation_id === candidate.recommendation_id
        && recommendation.tier === candidate.tier
        && recommendation.title === candidate.title
        && recommendation.does_not_authorize_runtime === true
    )))
    && recommendations.every((recommendation) => allowedTiers.includes(recommendation.tier)
      && recommendation.does_not_authorize_runtime === true
      && asArray(recommendation.blocked_side_effects).length > 0
      && asArray(recommendation.prerequisites).length > 0
      && asArray(recommendation.evidenceRefs).length > 0);
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

function hasOutboundRecipientIntent(text) {
  const outboundTerms = new Set(['send', 'sent', 'sending', 'email', 'message', 'messaging', 'contact', 'reply', 'outbound']);
  const recipientTerms = new Set(['customer', 'customers', 'client', 'clients', 'contact', 'contacts', 'recipient', 'recipients']);
  const tokens = String(text || '').toLowerCase().match(/[a-z0-9]+/g) || [];
  return tokens.some((token) => outboundTerms.has(token))
    && tokens.some((token) => recipientTerms.has(token));
}

function unsafeActionDriftOk(report, validationReport = {}) {
  const unsafePattern = /\b(tier[234]|runtime authorized|deploy|trade|money|move money|external send|memory commit|profile commit|capture|local execution|shell|pty)\b/i;
  const strings = [];
  for (const surface of [
    report.runner_request_contract,
    report.runner_response_contract,
    report.dry_run_result_enums,
    report.operator_visible_status,
    report.telemetry_audit_preview,
    report.rollback_disable_boundaries,
    report.next_phase_recommendations,
    asArray(validationReport.reasons),
  ]) {
    strings.push(...collectStringValues(surface));
  }
  return strings.every((text) => !unsafePattern.test(text) && !hasOutboundRecipientIntent(text));
}

function assertNoForbiddenOutput(value, extraForbidden = []) {
  const strings = collectStringValues(value);
  for (const forbidden of [...DEFAULT_FORBIDDEN_OUTPUT_SUBSTRINGS, ...extraForbidden]) {
    if (!forbidden) continue;
    const needle = String(forbidden).toLowerCase();
    if (strings.some((entry) => String(entry).toLowerCase().includes(needle))) {
      throw new Error(`runtime_dry_runner_forbidden_substring:${forbidden}`);
    }
  }
}

function validateContractReport(report = {}, contract = {}, validationReport = {}) {
  const checks = [];
  const errors = [];
  const resultById = {};
  const add = (id, ok) => {
    const result = resultObject(id, ok);
    checks.push(result);
    resultById[id] = result;
    if (!ok) errors.push(id);
  };
  const expected = dryRunnerExpected(contract);

  const baselineOk = report.baseline_commit === BASELINE_COMMIT;
  const dependencyOk = phase31DependencyOk(report, contract);
  const registryOk = registryCarryOk(report);
  const runnerOk = runnerContractOk(report, contract);
  const eligibilityOk = report.eligible_is_authorization === false
    && report.eligible_is_runtime_proof === false
    && report.runtime_available_now === false
    && report.runtime_started === false
    && report.runner_available_now === false
    && report.runner_executed === false;
  const flagKillOk = flagKillSwitchOk(report);
  const requestOk = requestContractOk(report, contract);
  const responseOk = responseContractOk(report, contract);
  const enumOk = resultEnumsOk(report, contract);
  const replayOk = idempotencyReplayOk(report);
  const boundaryOk = localBoundaryOk(report);
  const operatorOk = operatorStatusOk(report);
  const telemetrySafe = telemetryOk(report);
  const rollbackSafe = rollbackOk(report);
  const proofOk = proofBoundaryOk(report, contract);
  const targetOk = targetBoundaryOk(report);
  const effectsOk = blockedSideEffectsOk(report, contract);
  const unsafeOk = unsafeActionPolicyOk(report, contract) && unsafeActionDriftOk(report, validationReport);
  const recsOk = nextRecommendationsOk(report, contract);
  const literalsOk = literalValuesOk(report, expected.requiredLiteralValues || {});
  const idemOk = report.idempotency_key === runtimeDryRunnerIdempotencyKey(report);
  let forbiddenOk = true;
  try {
    assertNoForbiddenOutput(report, asArray(contract.forbiddenOutputSubstrings));
  } catch {
    forbiddenOk = false;
  }

  add('output-shape-complete',
    report.schema === RUNTIME_DRY_RUNNER_REPORT_SCHEMA_VERSION
      && hasRequiredFields(report, expected.requiredFields || REQUIRED_REPORT_FIELDS));
  add('baseline-83963ab-pinned', baselineOk);
  add('baseline_83963ab_pinned', baselineOk);
  add('phase31-dependency-carried-forward', dependencyOk && registryOk);
  add('phase31_dependency_current', dependencyOk);
  add('phase31_registry_counts_carried', registryOk);
  add('runner-remains-contract-only', runnerOk);
  add('runner_decision_default_contract_only', runnerOk);
  add('runtime_started_false', report.runtime_started === false);
  add('runtime_available_now_false', report.runtime_available_now === false);
  add('runner_available_now_false', report.runner_available_now === false);
  add('runner_executed_false', report.runner_executed === false);
  add('eligibility-non-authorizing', eligibilityOk);
  add('eligible_is_authorization_false', report.eligible_is_authorization === false);
  add('disabled-flag-and-kill-switch-required', flagKillOk);
  add('disabled_flag_dependency_required', flagKillOk && report.runtime_mode_flag_dependency?.required === true);
  add('kill_switch_dependency_fail_closed', flagKillOk && report.kill_switch_dependency?.fail_closed === true);
  add('request-contract-redacted-local-only', requestOk);
  add('request_contract_redacted_local_only', requestOk);
  add('response-contract-status-preview-only', responseOk);
  add('response_contract_status_preview_only', responseOk);
  add('dry-run-result-enums-complete', enumOk);
  add('result_enum_count', enumOk && asArray(report.dry_run_result_enums?.allowed_results).length === 12);
  add('idempotency-replay-rules-fail-closed', replayOk);
  add('idempotency_replay_fail_closed', replayOk);
  add('local-boundary-no-listener-network', boundaryOk);
  add('telemetry-audit-preview-only', telemetrySafe);
  add('telemetry_audit_preview_only', telemetrySafe);
  add('rollback-disable-boundaries-safe', rollbackSafe);
  add('proof-boundaries-false', proofOk);
  add('proof_boundaries_false', proofOk);
  add('server_can_execute_local_false', proofOk && report.proof_boundaries?.serverCanExecuteLocal === false);
  add('direct-builder-oracle-targets-blocked', targetOk);
  add('direct_builder_oracle_targets_blocked', targetOk);
  add('side-effects-blocked-now', effectsOk);
  add('side_effect_truth_all_blocked', effectsOk);
  add('unsafe-action-drift-blocked', unsafeOk);
  add('unsafe_action_drift_rejected', unsafeOk);
  add('next-recommendations-tier0-tier1-only', recsOk);
  add('next_recommendations_tier0_tier1_only', recsOk);
  add('no-raw-private-secret-output', forbiddenOk);
  add('no_raw_private_secret_content', forbiddenOk);
  add('idempotency-sensitive-to-runner-contract-inputs', idemOk);
  add('report-literal-values', literalsOk);
  add('validation-report-matches-contract',
    baselineOk && dependencyOk && registryOk && runnerOk && eligibilityOk && flagKillOk
      && requestOk && responseOk && enumOk && replayOk && boundaryOk && operatorOk
      && telemetrySafe && rollbackSafe && proofOk && targetOk && effectsOk && unsafeOk
      && recsOk && forbiddenOk && idemOk && literalsOk);

  return {
    ok: errors.length === 0,
    checks,
    errors,
    resultById,
  };
}

function buildValidationReport(contractReport, contract = {}, generatedAt = contractReport.generated_at) {
  const validation = validateContractReport(contractReport, contract);
  const failed = validation.checks.filter((check) => !check.ok);
  const checkResult = (id) => validation.resultById[id] || resultObject(id, false);
  const report = {
    schema: VALIDATION_REPORT_SCHEMA_VERSION,
    version: RUNTIME_DRY_RUNNER_VERSION,
    fixture_ref: 'ui/__tests__/fixtures/mira-core-runtime-dry-runner-contract.json',
    baseline_commit: BASELINE_COMMIT,
    accepted: validation.ok,
    decision: validation.ok ? 'accepted_validation_only' : 'rejected',
    reasons: failed.map((check) => check.id),
    checks: validation.checks,
    phase31_dependency_result: checkResult('phase31-dependency-carried-forward'),
    runner_contract_result: checkResult('runner-remains-contract-only'),
    request_response_contract_result: resultObject('request-response-contracts', checkResult('request-contract-redacted-local-only').ok
      && checkResult('response-contract-status-preview-only').ok),
    result_enum_result: checkResult('dry-run-result-enums-complete'),
    idempotency_replay_result: checkResult('idempotency-replay-rules-fail-closed'),
    side_effect_result: sideEffectResult(),
    proof_boundary_result: checkResult('proof-boundaries-false'),
    unsafe_action_result: checkResult('unsafe-action-drift-blocked'),
    evidenceRefs: [
      evidenceRef('mira-core-runtime-dry-runner', 'phase32-validation-report'),
    ],
  };
  assertNoForbiddenOutput(report, asArray(contract.forbiddenOutputSubstrings));
  return report;
}

function buildMiraCoreRuntimeDryRunner(options = {}) {
  const contract = options.contract || {};
  const runtime_dry_runner_contract_report = buildRuntimeDryRunnerContractReport(options);
  const validation_report = buildValidationReport(
    runtime_dry_runner_contract_report,
    contract,
    runtime_dry_runner_contract_report.generated_at,
  );
  const output = {
    runtime_dry_runner_contract_report,
    validation_report,
  };
  assertNoForbiddenOutput(output, asArray(contract.forbiddenOutputSubstrings));
  return output;
}

function validateMiraCoreRuntimeDryRunnerOutput(output = {}, contract = {}) {
  const checks = [];
  const errors = [];
  const add = (id, ok) => {
    checks.push({ id, ok: ok === true });
    if (!ok) errors.push(id);
  };
  const report = output.runtime_dry_runner_contract_report || {};
  const validationReport = output.validation_report || {};
  const contractValidation = validateContractReport(report, contract, validationReport);

  add('output-shape-complete',
    hasRequiredFields(output, contract.expectedOutputShape?.requiredTopLevelFields || REQUIRED_OUTPUT_FIELDS)
      && report.schema === RUNTIME_DRY_RUNNER_REPORT_SCHEMA_VERSION
      && validationReport.schema === VALIDATION_REPORT_SCHEMA_VERSION
      && hasRequiredFields(report, contract.expectedRuntimeDryRunnerContractReportShape?.requiredFields || REQUIRED_REPORT_FIELDS)
      && hasRequiredFields(validationReport, contract.expectedValidationReportShape?.requiredFields || REQUIRED_VALIDATION_REPORT_FIELDS));

  for (const check of contractValidation.checks) add(check.id, check.ok);

  add('validation-report-literal-values',
    validationReport.schema === VALIDATION_REPORT_SCHEMA_VERSION
      && validationReport.baseline_commit === BASELINE_COMMIT
      && literalValuesOk(validationReport, contract.expectedValidationReportShape?.requiredLiteralValues || {}));

  add('validation-report-side-effect-truth', sideEffectValuesOk(validationReport.side_effect_result));

  add('validation-report-matches-contract',
    validationReport.accepted === contractValidation.ok
      && validationReport.decision === (contractValidation.ok ? 'accepted_validation_only' : 'rejected')
      && idsEqual(asArray(validationReport.checks), 'id', contractValidation.checks.map((check) => check.id)));

  try {
    assertNoForbiddenOutput(output, asArray(contract.forbiddenOutputSubstrings));
    add('forbidden-output-strings-absent', true);
  } catch {
    add('forbidden-output-strings-absent', false);
  }

  return {
    ok: errors.length === 0,
    checks,
    errors,
  };
}

module.exports = {
  BASELINE_COMMIT,
  REQUIRED_OUTPUT_FIELDS,
  REQUIRED_REPORT_FIELDS,
  REQUIRED_SIDE_EFFECT_FIELDS,
  REQUIRED_VALIDATION_REPORT_FIELDS,
  RUNTIME_DRY_RUNNER_REPORT_SCHEMA_VERSION,
  RUNNER_ID,
  VALIDATION_REPORT_SCHEMA_VERSION,
  assertNoForbiddenOutput,
  buildMiraCoreRuntimeDryRunner,
  runtimeDryRunnerIdempotencyKey,
  stableHash,
  validateMiraCoreRuntimeDryRunnerOutput,
};
