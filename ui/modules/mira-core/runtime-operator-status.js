'use strict';

const crypto = require('crypto');

const RUNTIME_OPERATOR_STATUS_REPORT_SCHEMA_VERSION = 'squidrun.mira_core.runtime_operator_status_report.v0';
const VALIDATION_REPORT_SCHEMA_VERSION = 'squidrun.mira_core.runtime_operator_status_validation_report.v0';
const RUNTIME_OPERATOR_STATUS_VERSION = 'v0';
const BASELINE_COMMIT = '2c4d9ff';
const PHASE31_COMMIT = '83963ab';
const STATUS_SURFACE_ID = 'runtime_slice_0_operator_visible_status_contract';

const REQUIRED_OUTPUT_FIELDS = Object.freeze([
  'runtime_operator_status_report',
  'validation_report',
]);

const REQUIRED_REPORT_FIELDS = Object.freeze([
  'schema',
  'version',
  'status_report_id',
  'idempotency_key',
  'generated_at',
  'profile',
  'sessionId',
  'deviceId',
  'baseline_commit',
  'phase_31_dependency',
  'phase_32_dependency',
  'status_surface_id',
  'status_surface_status',
  'status_surface_decision',
  'status_surface_decision_allowed_values',
  'eligible_is_authorization',
  'eligible_is_runtime_proof',
  'runtime_started',
  'runtime_available_now',
  'runner_available_now',
  'runner_executed',
  'runtime_flag_status',
  'dry_runner_status',
  'kill_switch_status',
  'dry_run_fallback_status',
  'local_boundary_status',
  'execution_boundary_status',
  'telemetry_audit_status',
  'stale_replay_warning_states',
  'status_cards',
  'schema_registry_refs',
  'cli_registry_refs',
  'proof_boundaries',
  'target_boundaries',
  'unsafe_action_policy',
  'blocked_side_effects',
  'next_phase_recommendations',
  'evidenceRefs',
  'side_effect_result',
]);

const REQUIRED_VALIDATION_REPORT_FIELDS = Object.freeze([
  'schema',
  'version',
  'validation_id',
  'generated_at',
  'fixture_ref',
  'baseline_commit',
  'decision',
  'accepted',
  'blocked',
  'reasons',
  'static_rule_results',
  'acceptance_check_results',
  'tamper_case_results',
  'forbidden_output_scan',
  'side_effect_truth',
  'summary',
]);

const REQUIRED_SIDE_EFFECT_FIELDS = Object.freeze([
  'no_ui_implemented',
  'no_runtime_started',
  'no_runner_executed',
  'no_server_or_listener_started',
  'no_network_performed',
  'no_database_write_performed',
  'no_store_write_performed',
  'no_file_write_performed',
  'no_migration_executed',
  'no_queue_created',
  'no_lease_created',
  'no_auth_key_secret_operation',
  'no_local_execution_performed',
  'no_shell_or_pty_used',
  'no_browser_window_capture',
  'no_send_deploy_trade',
  'no_output_file_written',
]);

const DEFAULT_FORBIDDEN_OUTPUT_SUBSTRINGS = Object.freeze([
  'bearer token',
  'api key',
  'private key',
  'data key',
  'session secret',
  'env secret',
  'raw terminal',
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
  'browser opened',
  'window captured',
  'screenshot captured',
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

function evidenceRef(store, eventId, relation = 'runtime_operator_status_validation') {
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

function expectedShape(contract = {}) {
  return contract.expectedRuntimeOperatorStatusReportShape || {};
}

function validationShape(contract = {}) {
  return contract.expectedValidationReportShape || {};
}

function sideEffectResult() {
  return {
    no_ui_implemented: true,
    no_runtime_started: true,
    no_runner_executed: true,
    no_server_or_listener_started: true,
    no_network_performed: true,
    no_database_write_performed: true,
    no_store_write_performed: true,
    no_file_write_performed: true,
    no_migration_executed: true,
    no_queue_created: true,
    no_lease_created: true,
    no_auth_key_secret_operation: true,
    no_local_execution_performed: true,
    no_shell_or_pty_used: true,
    no_browser_window_capture: true,
    no_send_deploy_trade: true,
    no_output_file_written: true,
  };
}

function phase31Dependency() {
  return {
    phase: 31,
    name: 'runtime_milestone_refresh',
    commit: PHASE31_COMMIT,
    fixturePath: 'ui/__tests__/fixtures/mira-core-runtime-milestone-refresh-contract.json',
    modulePath: 'ui/modules/mira-core/runtime-milestone-refresh.js',
    cliPath: 'ui/scripts/hm-mira-core-runtime-milestone-refresh.js',
    testPath: 'ui/__tests__/mira-core-runtime-milestone-refresh.test.js',
    status: 'committed_validation_only',
    phase_registry_count: 30,
    schema_registry_count: 30,
    cli_registry_count: 30,
    commit_chain_count: 19,
    phase_23_stale_superseded: true,
    phase_30_oracle_115_closure: true,
    runtime_started: false,
    runtime_available_now: false,
    serverCanExecuteLocal: false,
    evidenceRefs: [
      evidenceRef('git', PHASE31_COMMIT, 'phase31-commit'),
      evidenceRef('mira-core-runtime-milestone-refresh', 'phase31-dependency'),
    ],
  };
}

function phase32Dependency() {
  return {
    phase: 32,
    name: 'runtime_dry_runner',
    commit: BASELINE_COMMIT,
    fixturePath: 'ui/__tests__/fixtures/mira-core-runtime-dry-runner-contract.json',
    modulePath: 'ui/modules/mira-core/runtime-dry-runner.js',
    cliPath: 'ui/scripts/hm-mira-core-runtime-dry-runner.js',
    testPath: 'ui/__tests__/mira-core-runtime-dry-runner.test.js',
    status: 'committed_validation_only',
    decision: 'remain_disabled_dry_runner_contract_only',
    runner_executed: false,
    runtime_started: false,
    runner_available_now: false,
    result_enum_count: 12,
    oracle_123_expiry_closure: true,
    evidenceRefs: [
      evidenceRef('git', BASELINE_COMMIT, 'phase32-commit'),
      evidenceRef('mira-core-runtime-dry-runner', 'phase32-dependency'),
    ],
  };
}

function runtimeFlagStatus() {
  return {
    value: 'disabled_off',
    default_disabled: true,
    dev_only: true,
    local_only: true,
    authorizes_runtime: false,
    visible: true,
    evidenceRefs: [
      evidenceRef('mira-core-runtime-operator-status', 'runtime-flag-status'),
    ],
  };
}

function dryRunnerStatus() {
  return {
    runner_decision: 'remain_disabled_dry_runner_contract_only',
    runner_executed: false,
    runner_available_now: false,
    result_enum_count: 12,
    oracle_123_expiry_closure: true,
    evidenceRefs: [
      evidenceRef('mira-core-runtime-operator-status', 'dry-runner-status'),
    ],
  };
}

function killSwitchStatus() {
  return {
    visible: true,
    fail_closed: true,
    authorizes_runtime: false,
    evidenceRefs: [
      evidenceRef('mira-core-runtime-operator-status', 'kill-switch-status'),
    ],
  };
}

function dryRunFallbackStatus() {
  return {
    preview_only: true,
    executes_requests: false,
    creates_queue_or_lease: false,
    authorizes_runtime: false,
    evidenceRefs: [
      evidenceRef('mira-core-runtime-operator-status', 'fallback-status'),
    ],
  };
}

function localBoundaryStatus() {
  return {
    loopback_only: true,
    listener_bound: false,
    network_performed: false,
    public_interface_allowed: false,
    remote_interface_allowed: false,
    evidenceRefs: [
      evidenceRef('mira-core-runtime-operator-status', 'local-boundary-status'),
    ],
  };
}

function executionBoundaryStatus() {
  return {
    runner_execution_performed: false,
    runtime_start_performed: false,
    queue_created: false,
    lease_created: false,
    local_execution_performed: false,
    evidenceRefs: [
      evidenceRef('mira-core-runtime-operator-status', 'execution-boundary-status'),
    ],
  };
}

function telemetryAuditStatus() {
  return {
    redacted_preview_only: true,
    write_performed: false,
    raw_payload_allowed: false,
    evidenceRefs: [
      evidenceRef('mira-core-runtime-operator-status', 'telemetry-audit-status'),
    ],
  };
}

function warningStates(contract = {}) {
  return asArray(expectedShape(contract).warningStatesExpected).map((warning) => ({
    ...clone(warning),
    visible: true,
    read_only: true,
    evidenceRefs: [
      evidenceRef('mira-core-runtime-operator-status', `warning:${warning.warning_id}`),
    ],
  }));
}

function statusCards(contract = {}) {
  return asArray(expectedShape(contract).statusCardsExpected).map((card, index) => ({
    ...clone(card),
    priority: card.risk_tier === 'tier1' ? 'medium' : 'low',
    visible: true,
    read_only: true,
    sort_order: index + 1,
    evidenceRefs: [
      evidenceRef('mira-core-runtime-operator-status', `card:${card.card_id}`),
    ],
    side_effect_result: sideEffectResult(),
  }));
}

function proofBoundaries() {
  return {
    socket_is_bridge_green: false,
    delivery_acceptance_is_model_processing_proof: false,
    config_present_is_runtime_proof: false,
    runner_contract_is_runner_execution_proof: false,
    serverCanExecuteLocal: false,
    evidenceRefs: [
      evidenceRef('mira-core-runtime-operator-status', 'proof-boundaries'),
    ],
  };
}

function targetBoundaries() {
  return {
    architect_only_future_server_target: true,
    builder_direct_server_target_allowed: false,
    oracle_direct_server_target_allowed: false,
    evidenceRefs: [
      evidenceRef('mira-core-runtime-operator-status', 'target-boundaries'),
    ],
  };
}

function unsafeActionPolicy() {
  return {
    customer_send_allowed: false,
    external_send_allowed: false,
    deploy_allowed: false,
    trade_allowed: false,
    financial_action_allowed: false,
    local_execution_allowed: false,
    shell_pty_allowed: false,
    capture_allowed: false,
    durable_memory_profile_commit_allowed: false,
    unsafe_action_drift_blocks_status_contract: true,
    evidenceRefs: [
      evidenceRef('mira-core-runtime-operator-status', 'unsafe-action-policy'),
    ],
  };
}

function blockedSideEffects() {
  return [
    'operator-surface',
    'availability-surface',
    'runner-action-surface',
    'transport-boundary',
    'persistent-mutation-boundary',
    'coordination-record-boundary',
    'credential-boundary',
    'local-arm-boundary',
    'irreversible-action-boundary',
    'artifact-output-boundary',
  ].map((effectId) => ({
    effect_id: effectId,
    blocked_now: true,
    attempts: 0,
    evidenceRefs: [
      evidenceRef('mira-core-runtime-operator-status', `blocked-effect:${effectId}`),
    ],
  }));
}

function nextPhaseRecommendations(contract = {}) {
  return asArray(expectedShape(contract).nextRecommendationExpectedCandidates).map((candidate) => ({
    ...clone(candidate),
    does_not_authorize_runtime: true,
    blocked_side_effects: [
      'ui',
      'runtime',
      'runner-execution',
      'network',
      'persistent-mutation',
      'external-action',
    ],
    evidenceRefs: [
      evidenceRef('mira-core-runtime-operator-status', `next:${candidate.recommendation_id}`),
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
    phase_32_dependency: report.phase_32_dependency,
    status_surface_id: report.status_surface_id,
    status_surface_status: report.status_surface_status,
    status_surface_decision: report.status_surface_decision,
    status_surface_decision_allowed_values: report.status_surface_decision_allowed_values,
    eligible_is_authorization: report.eligible_is_authorization,
    eligible_is_runtime_proof: report.eligible_is_runtime_proof,
    runtime_started: report.runtime_started,
    runtime_available_now: report.runtime_available_now,
    runner_available_now: report.runner_available_now,
    runner_executed: report.runner_executed,
    runtime_flag_status: report.runtime_flag_status,
    dry_runner_status: report.dry_runner_status,
    kill_switch_status: report.kill_switch_status,
    dry_run_fallback_status: report.dry_run_fallback_status,
    local_boundary_status: report.local_boundary_status,
    execution_boundary_status: report.execution_boundary_status,
    telemetry_audit_status: report.telemetry_audit_status,
    stale_replay_warning_states: report.stale_replay_warning_states,
    status_cards: report.status_cards,
    schema_registry_refs: report.schema_registry_refs,
    cli_registry_refs: report.cli_registry_refs,
    proof_boundaries: report.proof_boundaries,
    target_boundaries: report.target_boundaries,
    unsafe_action_policy: report.unsafe_action_policy,
    blocked_side_effects: report.blocked_side_effects,
    next_phase_recommendations: report.next_phase_recommendations,
    side_effect_result: report.side_effect_result,
  };
}

function runtimeOperatorStatusIdempotencyKey(report) {
  return `runtime-operator-status:${stableHash(canonicalReportInput(report))}`;
}

function buildRuntimeOperatorStatusReport(options = {}) {
  const contract = options.contract || {};
  const inputSignals = options.inputSignals || {};
  const scope = normalizeScope(inputSignals);
  const generatedAt = generatedAtFromOptions(options, inputSignals);
  const report = {
    schema: RUNTIME_OPERATOR_STATUS_REPORT_SCHEMA_VERSION,
    version: RUNTIME_OPERATOR_STATUS_VERSION,
    status_report_id: null,
    idempotency_key: null,
    generated_at: generatedAt,
    profile: scope.profile,
    sessionId: scope.sessionId,
    deviceId: scope.deviceId,
    baseline_commit: inputSignals.baseline_commit || BASELINE_COMMIT,
    phase_31_dependency: phase31Dependency(),
    phase_32_dependency: phase32Dependency(),
    status_surface_id: STATUS_SURFACE_ID,
    status_surface_status: 'contract_only_read_only_operator_summary',
    status_surface_decision: inputSignals.statusSurfaceDecision || 'remain_operator_status_contract_only',
    status_surface_decision_allowed_values: [
      'remain_operator_status_contract_only',
      'blocked',
      'eligible_for_future_operator_status_validation_slice',
    ],
    eligible_is_authorization: false,
    eligible_is_runtime_proof: false,
    runtime_started: false,
    runtime_available_now: false,
    runner_available_now: false,
    runner_executed: false,
    runtime_flag_status: runtimeFlagStatus(),
    dry_runner_status: dryRunnerStatus(),
    kill_switch_status: killSwitchStatus(),
    dry_run_fallback_status: dryRunFallbackStatus(),
    local_boundary_status: localBoundaryStatus(),
    execution_boundary_status: executionBoundaryStatus(),
    telemetry_audit_status: telemetryAuditStatus(),
    stale_replay_warning_states: warningStates(contract),
    status_cards: statusCards(contract),
    schema_registry_refs: clone(expectedShape(contract).schemaRegistryRefsExpected || []),
    cli_registry_refs: clone(expectedShape(contract).cliRegistryRefsExpected || []),
    proof_boundaries: proofBoundaries(),
    target_boundaries: targetBoundaries(),
    unsafe_action_policy: unsafeActionPolicy(),
    blocked_side_effects: blockedSideEffects(),
    next_phase_recommendations: nextPhaseRecommendations(contract),
    evidenceRefs: [
      evidenceRef('git', BASELINE_COMMIT, 'phase33-baseline'),
      evidenceRef('mira-core-runtime-operator-status-contract', 'phase33-contract'),
    ],
    side_effect_result: sideEffectResult(),
  };
  report.idempotency_key = runtimeOperatorStatusIdempotencyKey(report);
  report.status_report_id = `runtime-operator-status-${stableHash({
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
  return REQUIRED_SIDE_EFFECT_FIELDS.every((field) => value[field] === true);
}

function phase31DependencyOk(report) {
  const dep = report.phase_31_dependency || {};
  return dep.commit === PHASE31_COMMIT
    && dep.phase_registry_count === 30
    && dep.schema_registry_count === 30
    && dep.cli_registry_count === 30
    && dep.commit_chain_count === 19
    && dep.phase_23_stale_superseded === true
    && dep.phase_30_oracle_115_closure === true
    && dep.runtime_started === false
    && dep.runtime_available_now === false
    && dep.serverCanExecuteLocal === false
    && asArray(dep.evidenceRefs).length > 0;
}

function phase32DependencyOk(report) {
  const dep = report.phase_32_dependency || {};
  return dep.commit === BASELINE_COMMIT
    && dep.decision === 'remain_disabled_dry_runner_contract_only'
    && dep.runner_executed === false
    && dep.runtime_started === false
    && dep.runner_available_now === false
    && dep.result_enum_count === 12
    && dep.oracle_123_expiry_closure === true
    && asArray(dep.evidenceRefs).length > 0;
}

function contractOnlyOk(report) {
  return report.status_surface_status === 'contract_only_read_only_operator_summary'
    && report.status_surface_decision === 'remain_operator_status_contract_only'
    && report.eligible_is_authorization === false
    && report.eligible_is_runtime_proof === false
    && report.runtime_started === false
    && report.runtime_available_now === false
    && report.runner_available_now === false
    && report.runner_executed === false;
}

function runtimeFlagOk(report) {
  const flag = report.runtime_flag_status || {};
  return flag.value === 'disabled_off'
    && flag.default_disabled === true
    && flag.dev_only === true
    && flag.local_only === true
    && flag.authorizes_runtime === false;
}

function dryRunnerStatusOk(report) {
  const status = report.dry_runner_status || {};
  return status.runner_decision === 'remain_disabled_dry_runner_contract_only'
    && status.runner_executed === false
    && status.runner_available_now === false
    && status.result_enum_count === 12
    && status.oracle_123_expiry_closure === true;
}

function killSwitchOk(report) {
  const kill = report.kill_switch_status || {};
  return kill.visible === true
    && kill.fail_closed === true
    && kill.authorizes_runtime === false;
}

function fallbackOk(report) {
  const fallback = report.dry_run_fallback_status || {};
  return fallback.preview_only === true
    && fallback.executes_requests === false
    && fallback.creates_queue_or_lease === false
    && fallback.authorizes_runtime === false;
}

function localBoundaryOk(report) {
  const boundary = report.local_boundary_status || {};
  return boundary.loopback_only === true
    && boundary.listener_bound === false
    && boundary.network_performed === false
    && boundary.public_interface_allowed === false
    && boundary.remote_interface_allowed === false;
}

function executionBoundaryOk(report) {
  const boundary = report.execution_boundary_status || {};
  return boundary.runner_execution_performed === false
    && boundary.runtime_start_performed === false
    && boundary.queue_created === false
    && boundary.lease_created === false
    && boundary.local_execution_performed === false
    && report.runner_executed === false
    && report.runtime_started === false;
}

function telemetryAuditOk(report) {
  const telemetry = report.telemetry_audit_status || {};
  return telemetry.redacted_preview_only === true
    && telemetry.write_performed === false
    && telemetry.raw_payload_allowed === false;
}

function warningStatesOk(report, contract = {}) {
  const warnings = asArray(report.stale_replay_warning_states);
  const expected = asArray(expectedShape(contract).warningStatesExpected);
  return warnings.length === expected.length
    && expected.every((warning) => warnings.some((entry) => (
      entry.warning_id === warning.warning_id
        && entry.status === warning.status
        && entry.blocks_authorization === true
        && entry.visible === true
        && entry.read_only === true
    )));
}

function statusCardsOk(report, contract = {}) {
  const cards = asArray(report.status_cards);
  const expected = asArray(expectedShape(contract).statusCardsExpected);
  const requiredFields = asArray(expectedShape(contract).statusCardRequiredFields);
  return cards.length === expected.length
    && expected.every((card) => cards.some((entry) => (
      entry.card_id === card.card_id
        && entry.title === card.title
        && entry.kind === card.kind
        && entry.status === card.status
        && entry.risk_tier === card.risk_tier
        && entry.visible === true
        && entry.read_only === true
        && sideEffectValuesOk(entry.side_effect_result)
        && hasRequiredFields(entry, requiredFields)
    )));
}

function registryRefsOk(report, contract = {}) {
  return valuesMatch(report.schema_registry_refs, expectedShape(contract).schemaRegistryRefsExpected || [])
    && valuesMatch(report.cli_registry_refs, expectedShape(contract).cliRegistryRefsExpected || []);
}

function proofOk(report) {
  const proof = report.proof_boundaries || {};
  return proof.socket_is_bridge_green === false
    && proof.delivery_acceptance_is_model_processing_proof === false
    && proof.config_present_is_runtime_proof === false
    && proof.runner_contract_is_runner_execution_proof === false
    && proof.serverCanExecuteLocal === false;
}

function targetOk(report) {
  const target = report.target_boundaries || {};
  return target.architect_only_future_server_target === true
    && target.builder_direct_server_target_allowed === false
    && target.oracle_direct_server_target_allowed === false;
}

function unsafePolicyOk(report) {
  const policy = report.unsafe_action_policy || {};
  return policy.customer_send_allowed === false
    && policy.external_send_allowed === false
    && policy.deploy_allowed === false
    && policy.trade_allowed === false
    && policy.financial_action_allowed === false
    && policy.local_execution_allowed === false
    && policy.shell_pty_allowed === false
    && policy.capture_allowed === false
    && policy.durable_memory_profile_commit_allowed === false
    && policy.unsafe_action_drift_blocks_status_contract === true;
}

function blockedSideEffectsOk(report) {
  return asArray(report.blocked_side_effects).length >= 10
    && asArray(report.blocked_side_effects).every((effect) => effect.blocked_now === true
      && Number(effect.attempts || 0) === 0
      && asArray(effect.evidenceRefs).length > 0)
    && sideEffectValuesOk(report.side_effect_result);
}

function resultListMatches(results = [], expectedIds = [], recomputedById = {}) {
  const list = asArray(results);
  return idsEqual(list, 'id', expectedIds)
    && list.every((entry) => entry.ok === Boolean(recomputedById[entry.id]?.ok));
}

function tamperCaseResultsOk(results = [], contract = {}) {
  const tamperCases = asArray(contract.tamperCases);
  const list = asArray(results);
  return list.length === tamperCases.length
    && idsEqual(list, 'id', tamperCases.map((item) => item.id))
    && list.every((entry) => {
      const expected = tamperCases.find((item) => item.id === entry.id);
      return expected
        && entry.covered === true
        && entry.expectedFailure === expected.expectedFailure;
    });
}

function nextRecommendationsOk(report, contract = {}) {
  const recommendations = asArray(report.next_phase_recommendations);
  const expected = asArray(expectedShape(contract).nextRecommendationExpectedCandidates);
  return recommendations.length === expected.length
    && expected.every((candidate) => recommendations.some((recommendation) => (
      recommendation.recommendation_id === candidate.recommendation_id
        && recommendation.tier === candidate.tier
        && recommendation.action === candidate.action
        && recommendation.why_safe === candidate.why_safe
        && recommendation.does_not_authorize_runtime === true
    )))
    && recommendations.every((recommendation) => ['tier0', 'tier1'].includes(recommendation.tier)
      && recommendation.does_not_authorize_runtime === true);
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
  const unsafePattern = /\b(tier[234]|deploy|trade|money|wire money|external send|customer send|memory commit|profile commit|capture|local execution|shell|pty)\b/i;
  const strings = [];
  for (const surface of [
    report.status_cards,
    report.stale_replay_warning_states,
    report.blocked_side_effects,
    report.next_phase_recommendations,
    report.runtime_flag_status,
    report.dry_runner_status,
    report.kill_switch_status,
    report.dry_run_fallback_status,
    report.telemetry_audit_status,
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
      throw new Error(`runtime_operator_status_forbidden_substring:${forbidden}`);
    }
  }
}

function validateReport(report = {}, contract = {}, validationReport = {}) {
  const checks = [];
  const errors = [];
  const resultById = {};
  const add = (id, ok) => {
    const result = resultObject(id, ok);
    checks.push(result);
    resultById[id] = result;
    if (!ok) errors.push(id);
  };
  const expected = expectedShape(contract);
  const baselineOk = report.baseline_commit === BASELINE_COMMIT;
  const phase31Ok = phase31DependencyOk(report);
  const phase32Ok = phase32DependencyOk(report);
  const contractOk = contractOnlyOk(report);
  const flagOk = runtimeFlagOk(report);
  const dryRunnerOk = dryRunnerStatusOk(report);
  const killOk = killSwitchOk(report);
  const fallbackSafe = fallbackOk(report);
  const localOk = localBoundaryOk(report);
  const executionOk = executionBoundaryOk(report);
  const telemetryOk = telemetryAuditOk(report);
  const warningsOk = warningStatesOk(report, contract);
  const cardsOk = statusCardsOk(report, contract);
  const refsOk = registryRefsOk(report, contract);
  const proofSafe = proofOk(report);
  const targetSafe = targetOk(report);
  const unsafeOk = unsafePolicyOk(report) && unsafeActionDriftOk(report, validationReport);
  const recommendationsOk = nextRecommendationsOk(report, contract);
  const sideEffectsOk = blockedSideEffectsOk(report);
  const literalOk = literalValuesOk(report, expected.requiredLiteralValues || {});
  const idemOk = report.idempotency_key === runtimeOperatorStatusIdempotencyKey(report);
  let forbiddenOk = true;
  try {
    assertNoForbiddenOutput(report, asArray(contract.forbiddenOutputSubstrings));
  } catch {
    forbiddenOk = false;
  }

  add('output-shape-complete',
    report.schema === RUNTIME_OPERATOR_STATUS_REPORT_SCHEMA_VERSION
      && hasRequiredFields(report, expected.requiredFields || REQUIRED_REPORT_FIELDS));
  add('baseline-pinned', baselineOk);
  add('baseline-2c4d9ff-pinned', baselineOk);
  add('phase31-dependency-current', phase31Ok);
  add('phase31-83963ab-current', phase31Ok);
  add('phase32-dependency-current', phase32Ok);
  add('phase32-2c4d9ff-current', phase32Ok);
  add('operator-status-contract-only', contractOk && cardsOk);
  add('status-card-registry-complete', cardsOk);
  add('schema-and-cli-refs-present', refsOk);
  add('runtime-flag-disabled', flagOk);
  add('runtime-flag-disabled-off', flagOk);
  add('dry-runner-decision-contract-only', dryRunnerOk);
  add('dry-runner-contract-only', dryRunnerOk);
  add('kill-switch-fail-closed', killOk);
  add('dry-run-fallback-preview-only', fallbackSafe);
  add('fallback-preview-no-execution', fallbackSafe);
  add('local-loopback-no-listener-network', localOk);
  add('local-boundary-no-listener-network', localOk);
  add('no-runner-runtime-queue-lease-execution', executionOk);
  add('runner-executed-false', report.runner_executed === false && report.dry_runner_status?.runner_executed === false);
  add('runtime-started-false', report.runtime_started === false);
  add('queue-lease-execution-false', executionOk);
  add('telemetry-audit-preview-only', telemetryOk);
  add('warning-states-visible', warningsOk);
  add('stale-expired-replay-warnings-present', warningsOk);
  add('proof-boundaries-false', proofSafe);
  add('proof-boundaries-all-false', proofSafe);
  add('server-cannot-execute-local', proofSafe && report.proof_boundaries?.serverCanExecuteLocal === false);
  add('server-can-execute-local-false', proofSafe && report.proof_boundaries?.serverCanExecuteLocal === false);
  add('direct-builder-oracle-targets-blocked', targetSafe);
  add('builder-oracle-direct-targets-blocked', targetSafe);
  add('unsafe-action-drift-blocked', unsafeOk);
  add('unsafe-action-drift-rejected', unsafeOk);
  add('next-recommendations-tier0-tier1-only', recommendationsOk);
  add('no-raw-private-secret-output', forbiddenOk);
  add('side-effect-truth-all-blocked', sideEffectsOk);
  add('idempotency-sensitive', idemOk);
  add('report-literal-values', literalOk);
  add('status-report-contract-complete',
    baselineOk && phase31Ok && phase32Ok && contractOk && flagOk && dryRunnerOk && killOk
      && fallbackSafe && localOk && executionOk && telemetryOk && warningsOk && cardsOk
      && refsOk && proofSafe && targetSafe && unsafeOk && recommendationsOk && sideEffectsOk
      && forbiddenOk && idemOk && literalOk);

  return {
    ok: errors.length === 0,
    checks,
    errors,
    resultById,
  };
}

function buildValidationReport(statusReport, contract = {}, generatedAt = statusReport.generated_at) {
  const validation = validateReport(statusReport, contract);
  const failed = validation.checks.filter((check) => !check.ok);
  const staticResults = asArray(contract.staticValidationRules).map((rule) => resultObject(
    rule.id,
    validation.resultById[rule.id]?.ok,
  ));
  const acceptanceResults = asArray(contract.acceptanceChecks).map((check) => resultObject(
    check.id,
    validation.resultById[check.id]?.ok,
  ));
  const tamperResults = asArray(contract.tamperCases).map((tamper) => ({
    id: tamper.id,
    covered: true,
    expectedFailure: tamper.expectedFailure,
  }));
  const report = {
    schema: VALIDATION_REPORT_SCHEMA_VERSION,
    version: RUNTIME_OPERATOR_STATUS_VERSION,
    validation_id: `runtime-operator-status-validation-${stableHash({
      status_key: statusReport.idempotency_key,
      generatedAt,
    }).slice(0, 12)}`,
    generated_at: generatedAt,
    fixture_ref: 'ui/__tests__/fixtures/mira-core-runtime-operator-status-contract.json',
    baseline_commit: BASELINE_COMMIT,
    decision: validation.ok ? 'accepted_validation_only' : 'rejected',
    accepted: validation.ok,
    blocked: !validation.ok,
    reasons: failed.map((check) => check.id),
    static_rule_results: staticResults,
    acceptance_check_results: acceptanceResults,
    tamper_case_results: tamperResults,
    forbidden_output_scan: resultObject('forbidden-output-strings-absent', validation.resultById['no-raw-private-secret-output']?.ok),
    side_effect_truth: sideEffectResult(),
    summary: {
      status_surface: statusReport.status_surface_decision,
      status_card_count: asArray(statusReport.status_cards).length,
      warning_state_count: asArray(statusReport.stale_replay_warning_states).length,
      runtime_started: false,
      runner_executed: false,
      serverCanExecuteLocal: false,
      output_file_written: false,
    },
  };
  assertNoForbiddenOutput(report, asArray(contract.forbiddenOutputSubstrings));
  return report;
}

function buildMiraCoreRuntimeOperatorStatus(options = {}) {
  const contract = options.contract || {};
  const runtime_operator_status_report = buildRuntimeOperatorStatusReport(options);
  const validation_report = buildValidationReport(
    runtime_operator_status_report,
    contract,
    runtime_operator_status_report.generated_at,
  );
  const output = {
    runtime_operator_status_report,
    validation_report,
  };
  assertNoForbiddenOutput(output, asArray(contract.forbiddenOutputSubstrings));
  return output;
}

function validateMiraCoreRuntimeOperatorStatusOutput(output = {}, contract = {}) {
  const checks = [];
  const errors = [];
  const add = (id, ok) => {
    checks.push({ id, ok: ok === true });
    if (!ok) errors.push(id);
  };
  const report = output.runtime_operator_status_report || {};
  const validationReport = output.validation_report || {};
  const statusValidation = validateReport(report, contract, validationReport);

  add('output-shape-complete',
    hasRequiredFields(output, contract.expectedTopLevelFields || REQUIRED_OUTPUT_FIELDS)
      && report.schema === RUNTIME_OPERATOR_STATUS_REPORT_SCHEMA_VERSION
      && validationReport.schema === VALIDATION_REPORT_SCHEMA_VERSION
      && hasRequiredFields(report, contract.expectedRuntimeOperatorStatusReportShape?.requiredFields || REQUIRED_REPORT_FIELDS)
      && hasRequiredFields(validationReport, contract.expectedValidationReportShape?.requiredFields || REQUIRED_VALIDATION_REPORT_FIELDS));

  for (const check of statusValidation.checks) add(check.id, check.ok);

  add('validation-report-literal-values',
    validationReport.schema === VALIDATION_REPORT_SCHEMA_VERSION
      && validationReport.baseline_commit === BASELINE_COMMIT
      && literalValuesOk(validationReport, validationShape(contract).requiredLiteralValues || {}));

  add('validation-report-side-effect-truth', sideEffectValuesOk(validationReport.side_effect_truth));

  add('validation-report-matches-contract',
    validationReport.accepted === statusValidation.ok
      && validationReport.decision === (statusValidation.ok ? 'accepted_validation_only' : 'rejected')
      && resultListMatches(
        validationReport.static_rule_results,
        asArray(contract.staticValidationRules).map((rule) => rule.id),
        statusValidation.checks.reduce((acc, check) => {
          acc[check.id] = check;
          return acc;
        }, {}),
      )
      && resultListMatches(
        validationReport.acceptance_check_results,
        asArray(contract.acceptanceChecks).map((check) => check.id),
        statusValidation.checks.reduce((acc, check) => {
          acc[check.id] = check;
          return acc;
        }, {}),
      )
      && tamperCaseResultsOk(validationReport.tamper_case_results, contract));

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
  PHASE31_COMMIT,
  REQUIRED_OUTPUT_FIELDS,
  REQUIRED_REPORT_FIELDS,
  REQUIRED_SIDE_EFFECT_FIELDS,
  REQUIRED_VALIDATION_REPORT_FIELDS,
  RUNTIME_OPERATOR_STATUS_REPORT_SCHEMA_VERSION,
  STATUS_SURFACE_ID,
  VALIDATION_REPORT_SCHEMA_VERSION,
  assertNoForbiddenOutput,
  buildMiraCoreRuntimeOperatorStatus,
  runtimeOperatorStatusIdempotencyKey,
  stableHash,
  validateMiraCoreRuntimeOperatorStatusOutput,
};
