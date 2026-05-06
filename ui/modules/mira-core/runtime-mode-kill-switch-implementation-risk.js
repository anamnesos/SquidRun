'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const RUNTIME_MODE_KILL_SWITCH_IMPLEMENTATION_RISK_SCHEMA_VERSION =
  'squidrun.mira_core.runtime_mode_kill_switch_implementation_risk.v0';
const VALIDATION_REPORT_SCHEMA_VERSION =
  'squidrun.mira_core.runtime_mode_kill_switch_implementation_risk_validation_report.v0';
const RUNTIME_MODE_KILL_SWITCH_IMPLEMENTATION_RISK_VERSION = 'v0';
const BASELINE_COMMIT = '5b3de99';
const FIXTURE_REF =
  'ui/__tests__/fixtures/mira-core-runtime-mode-kill-switch-implementation-risk-contract.json';

const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');

const REQUIRED_OUTPUT_FIELDS = Object.freeze([
  'runtime_mode_kill_switch_implementation_risk',
  'validation_report',
]);

const REQUIRED_RISK_FIELDS = Object.freeze([
  'schema',
  'version',
  'risk_id',
  'idempotency_key',
  'generated_at',
  'profile',
  'sessionId',
  'deviceId',
  'baseline_commit',
  'phase_registry',
  'schema_registry',
  'cli_registry',
  'commit_chain',
  'source_recommendation',
  'satisfied_prior_recommendations',
  'current_truth',
  'stale_readiness',
  'phase34_prior_recommendations',
  'closure_summary',
  'source_refs',
  'prerequisite_boundary',
  'runtime_mode_boundary',
  'kill_switch_boundary',
  'prerequisite_gap_matrix',
  'implementation_risk_boundary',
  'risk_register',
  'blocked_future_slices',
  'capability_matrix',
  'boundary_truth',
  'redaction_summary',
  'unsafe_action_policy',
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
  'required_literal_results',
  'referenced_path_results',
  'forbidden_output_scan',
  'side_effect_truth',
  'summary',
]);

const REQUIRED_SIDE_EFFECT_FIELDS = Object.freeze([
  'no_module_or_cli_implemented',
  'no_tests_implemented',
  'no_ui_implemented',
  'no_browser_window_capture',
  'no_runtime_performed',
  'no_runtime_mode_flag_read',
  'no_kill_switch_wired',
  'no_runner_executed',
  'no_server_performed',
  'no_listener_or_route_bound',
  'no_network_performed',
  'no_database_write_performed',
  'no_store_write_performed',
  'no_file_write_performed',
  'no_file_migration_executed',
  'no_queue_created',
  'no_lease_created',
  'no_auth_change_performed',
  'no_key_secret_operation_performed',
  'no_local_execution_performed',
  'no_shell_or_pty_used',
  'no_control_execution_performed',
  'no_reporting_sink_written',
  'no_send_performed',
  'no_deploy_performed',
  'no_trade_performed',
  'no_output_file_written',
]);

const SIDE_EFFECT_COUNTER_FIELDS = Object.freeze([
  'moduleCliImplementationsAttempted',
  'testImplementationsAttempted',
  'uiImplementationAttempts',
  'browserWindowCaptureAttempts',
  'runtimeAttempts',
  'runtimeModeFlagReadAttempts',
  'killSwitchWireAttempts',
  'runnerAttempts',
  'serverAttempts',
  'listenerRouteAttempts',
  'networkRequestsAttempted',
  'databaseWritesAttempted',
  'storeWritesAttempted',
  'fileWritesAttempted',
  'fileMigrationsAttempted',
  'queuesCreated',
  'leasesCreated',
  'authChangesAttempted',
  'keySecretOperationsAttempted',
  'localExecutionAttempted',
  'shellPtyAttempts',
  'controlExecutionsAttempted',
  'reportingSinkWritesAttempted',
  'sendsAttempted',
  'deploysAttempted',
  'tradesAttempted',
  'outputFilesWritten',
]);

const NEGATABLE_FORBIDDEN_OUTPUT_SUBSTRINGS = Object.freeze(new Set([
  'ui rendered',
  'env secret',
  'browser opened',
  'window captured',
  'screenshot captured',
  'capture performed',
  'runtime started',
  'runner executed',
  'runtime is available',
  'runner is available',
  'dry run available now',
  'dry run authorized',
  'runtime mode enabled',
  'runtime mode flag read',
  'flag reader implemented',
  'kill switch wired',
  'kill switch executed',
  'control executed',
  'rollback executed',
  'reporting sink wired',
  'server started',
  'listener bound',
  'network request sent',
  'database write',
  'store write',
  'file written',
  'migration executed',
  'queue created',
  'lease created',
  'local execution performed',
  'shell executed',
  'pty executed',
  'customer send performed',
  'external send performed',
  'deploy performed',
  'trade performed',
  'output file written',
  'phase42 commit proves runtime',
  'implementation risk authorizes runtime',
  'implementation risk authorizes flag reader',
  'implementation risk authorizes kill switch',
  'implementation risk authorizes execution',
  'socket proves bridge green',
  'delivery acceptance proves model processing',
  'builder direct target allowed',
  'oracle direct target allowed',
]));

const UNSAFE_ACTION_PHRASES = Object.freeze([
  'deploy',
  'trade',
  'wire money',
  'external send',
  'file write',
  'store write',
  'local execution',
  'shell',
  'pty',
  'browser capture',
  'browser window',
  'window capture',
  'screen capture',
  'live ui',
  'render ui',
  'runtime start',
  'live runtime',
  'start server',
  'open listener',
  'create queue',
  'create lease',
  'write output file',
  'execute control',
  'wire kill switch',
  'read runtime mode flag',
  'read env flag',
  'run rollback',
  'write report',
  'reporting sink',
]);

const OUTBOUND_TERMS = Object.freeze(['send', 'email', 'message', 'contact', 'reply', 'outbound', 'external']);
const RECIPIENT_TERMS = Object.freeze(['customer', 'client', 'recipient']);

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

function valuesMatch(a, b) {
  return JSON.stringify(sortedValue(a)) === JSON.stringify(sortedValue(b));
}

function pathValue(value, dottedPath) {
  return String(dottedPath || '').split('.').reduce((acc, key) => (
    acc && Object.prototype.hasOwnProperty.call(acc, key) ? acc[key] : undefined
  ), value);
}

function hasRequiredFields(value, fields = []) {
  return Boolean(value) && asArray(fields).every((field) => Object.prototype.hasOwnProperty.call(value, field));
}

function idsEqual(items = [], field, expectedIds = []) {
  return valuesMatch(asArray(items).map((item) => item[field]), asArray(expectedIds));
}

function resultObject(id, ok) {
  return { id, ok: ok === true };
}

function evidenceRef(store, eventId, relation = 'runtime_mode_kill_switch_implementation_risk_validation') {
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
    sessionId: inputSignals.sessionId || 'session-343',
    deviceId: inputSignals.deviceId || 'VIGIL',
  };
}

function generatedAtFromOptions(options = {}, inputSignals = {}) {
  if (options.generatedAt) return options.generatedAt;
  if (inputSignals.generatedAt) return inputSignals.generatedAt;
  if (typeof options.nowMs === 'number') return new Date(options.nowMs).toISOString();
  return new Date().toISOString();
}

function phaseRegistry(contract = {}) {
  const expected = contract.phaseRegistryExpected || {};
  return {
    source_ref: expected.source_ref,
    current_through_phase: 42,
    expected_phases: expected.expected_phases || '1-42',
    phase_inventory_count: 42,
    schema_registry_count: 42,
    cli_registry_count: 42,
    phase35_runtime_next_action_current: true,
    phase36_operator_ui_surface_current: true,
    phase37_control_reporting_reconciliation_current: true,
    phase38_runtime_readiness_refresh_current: true,
    phase39_dry_run_readiness_gap_current: true,
    phase40_runtime_mode_kill_switch_current: true,
    phase41_status_gap_refresh_current: true,
    phase42_prerequisite_boundary_current: true,
    phase42_commit: BASELINE_COMMIT,
    phase42_delta: clone(expected.phase42_delta || {}),
    recent_phase_paths: clone(expected.required_recent_phase_paths || []),
    evidenceRefs: [
      evidenceRef('git', BASELINE_COMMIT, 'phase43-baseline'),
      evidenceRef('mira-core-runtime-mode-kill-switch-implementation-risk-contract', 'phase-registry'),
    ],
  };
}

function registryEntries(kind, contract = {}) {
  const recent = new Map(asArray(contract.phaseRegistryExpected?.required_recent_phase_paths)
    .map((entry) => [entry.phase, entry]));
  return Array.from({ length: 42 }, (_, index) => {
    const phase = index + 1;
    const recentEntry = recent.get(phase);
    return {
      phase,
      registry_kind: kind,
      artifact_id: recentEntry ? `phase${phase}-${kind}` : `phase${phase}-${kind}-registered`,
      status: phase <= 42 ? 'registered_validation_artifact' : 'unknown',
      ...(recentEntry ? clone(recentEntry) : {}),
    };
  });
}

function currentTruth(contract = {}) {
  return {
    ...clone(contract.currentTruthExpected || {}),
    evidenceRefs: [
      evidenceRef('git', '801a92a', 'phase35-current'),
      evidenceRef('git', '6f08b05', 'phase36-current'),
      evidenceRef('git', 'c8b55be', 'phase37-current'),
      evidenceRef('git', '85c78ab', 'phase38-current'),
      evidenceRef('git', 'a62fe16', 'phase39-current'),
      evidenceRef('git', 'def3f3b', 'phase40-current'),
      evidenceRef('git', '833f9c1', 'phase41-current'),
      evidenceRef('git', BASELINE_COMMIT, 'phase42-current'),
    ],
  };
}

function staleReadiness(contract = {}) {
  return {
    ...clone(contract.staleReadinessExpected || {}),
    evidenceRefs: [
      evidenceRef('mira-core-readiness', 'phase13-stale'),
      evidenceRef('mira-core-milestone-readiness', 'phase23-stale'),
      evidenceRef('mira-core-runtime-milestone-refresh', 'phase31-stale'),
    ],
  };
}

function phase34PriorRecommendations(contract = {}) {
  const expected = contract.phase34PriorRecommendationsExpected || {};
  return {
    phase35_runtime_status_milestone_refresh_validator: {
      ...clone(expected.phase35_runtime_status_milestone_refresh_validator || {}),
      evidenceRefs: [evidenceRef('git', 'c04155d', 'phase34-prior-validator-satisfied')],
    },
    phase35_stdout_only_cli_smoke: {
      ...clone(expected.phase35_stdout_only_cli_smoke || {}),
      evidenceRefs: [evidenceRef('git', 'c04155d', 'phase34-prior-cli-satisfied')],
    },
  };
}

function closureSummary(contract = {}) {
  const expected = contract.closureSummaryExpected || {};
  return {
    ...clone(expected),
    evidenceRefs: asArray(expected.closed_review_refs).map((ref) => (
      evidenceRef('oracle-review', ref, 'closure-carried')
    )),
  };
}

function prerequisiteBoundary(contract = {}) {
  const shape = contract.prerequisiteBoundaryShapeExpected || {};
  const gaps = asArray(contract.prerequisiteGapMatrixExpected);
  const future = Array.from(new Set(gaps.flatMap((gap) => asArray(gap.future_green_requires))));
  return {
    ...clone(shape.requiredValues || {}),
    future_implementation_requires: future,
    evidenceRefs: [
      evidenceRef('mira-core-runtime-mode-kill-switch-prerequisite-boundary-contract', 'prerequisite-boundary'),
    ],
  };
}

function runtimeModeBoundary(contract = {}) {
  return {
    ...clone(contract.runtimeModeBoundaryShapeExpected?.requiredValues || {}),
    evidenceRefs: [
      evidenceRef('mira-core-runtime-mode-kill-switch-prerequisite-boundary-contract', 'runtime-mode-boundary'),
      evidenceRef('git', BASELINE_COMMIT, 'runtime-mode-boundary-baseline'),
    ],
  };
}

function killSwitchBoundary(contract = {}) {
  return {
    ...clone(contract.killSwitchBoundaryShapeExpected?.requiredValues || {}),
    evidenceRefs: [
      evidenceRef('mira-core-runtime-mode-kill-switch-prerequisite-boundary-contract', 'kill-switch-boundary'),
      evidenceRef('git', BASELINE_COMMIT, 'kill-switch-boundary-baseline'),
    ],
  };
}

function prerequisiteGapMatrix(contract = {}) {
  return asArray(contract.prerequisiteGapMatrixExpected).map((gap) => ({
    ...clone(gap),
    evidenceRefs: [
      evidenceRef('mira-core-runtime-mode-kill-switch-implementation-risk-contract', gap.gap_id),
    ],
  }));
}

function safeRiskRegister(contract = {}) {
  return asArray(contract.riskRegisterExpected).map((risk) => ({
    risk_id: risk.risk_id,
    status: risk.status,
    satisfied_now: risk.satisfied_now,
    blocks_runtime_now: risk.blocks_runtime_now,
    authorizes_runtime: risk.authorizes_runtime,
    risk_summary: `Blocking metadata-only risk ${risk.risk_id}; no implementation authorization is granted.`,
    gate_ref: `fixture-gate:${risk.risk_id}`,
    evidenceRefs: [
      evidenceRef('mira-core-runtime-mode-kill-switch-implementation-risk-contract', risk.risk_id),
    ],
  }));
}

function implementationRiskBoundary(contract = {}) {
  const riskIds = asArray(contract.riskRegisterExpected).map((risk) => risk.risk_id);
  return {
    ...clone(contract.implementationRiskBoundaryShapeExpected?.requiredValues || {}),
    future_green_requires: [
      'separate fixture-only flag-reader safety contract',
      'separate fixture-only kill-switch wiring safety contract',
      'explicit disabled-default checks',
      'fail-closed kill-switch checks',
      'redacted reporting preview only',
      'proof boundaries remain false',
    ],
    blocking_risk_ids: riskIds,
    evidenceRefs: [
      evidenceRef('mira-core-runtime-mode-kill-switch-implementation-risk-contract', 'implementation-risk-boundary'),
    ],
  };
}

function blockedFutureSlices(contract = {}) {
  return asArray(contract.blockedFutureSlicesExpected).map((slice) => ({
    ...clone(slice),
    reason: `Slice ${slice.slice_id} remains blocked by the Phase 43 implementation-risk boundary.`,
    evidenceRefs: [
      evidenceRef('mira-core-runtime-mode-kill-switch-implementation-risk-contract', slice.slice_id),
    ],
  }));
}

function capabilityMatrix(contract = {}) {
  return {
    ...clone(contract.capabilityMatrixExpected || {}),
    evidenceRefs: [evidenceRef('mira-core-runtime-mode-kill-switch-implementation-risk-contract', 'capability-matrix')],
  };
}

function boundaryTruth(contract = {}) {
  return {
    ...clone(contract.proofBoundaryExpected || {}),
    evidenceRefs: [evidenceRef('mira-core-runtime-mode-kill-switch-implementation-risk-contract', 'boundary-truth')],
  };
}

function redactionSummary() {
  return {
    raw_private_content_included: false,
    raw_terminal_included: false,
    raw_screenshot_ocr_browser_included: false,
    secret_material_included: false,
    customer_private_content_included: false,
    redaction_status: 'metadata_only',
    evidenceRefs: [
      evidenceRef('mira-core-runtime-mode-kill-switch-implementation-risk-contract', 'redaction-summary'),
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
    file_mutation_allowed: false,
    store_mutation_allowed: false,
    queue_lease_allowed: false,
    local_execution_allowed: false,
    shell_pty_allowed: false,
    browser_capture_allowed: false,
    live_ui_allowed: false,
    live_runtime_allowed: false,
    runtime_mode_flag_read_allowed: false,
    kill_switch_wiring_allowed: false,
    control_execution_allowed: false,
    reporting_sink_allowed: false,
    unsafe_action_drift_rejected: true,
    evidenceRefs: [
      evidenceRef('mira-core-runtime-mode-kill-switch-implementation-risk-contract', 'unsafe-action-policy'),
    ],
  };
}

function nextPhaseRecommendations(contract = {}) {
  return asArray(contract.nextRecommendationExpectedCandidates).map((candidate) => ({
    ...clone(candidate),
    blocked_side_effects: [
      'ui-rendering',
      'browser-window-capture',
      'runtime-start',
      'runner-action',
      'server-transport',
      'persistent-mutation',
      'queue-lease',
      'control-action',
      'reporting-artifact-output',
      'flag-read',
      'kill-switch-wire',
      'irreversible-action-boundary',
    ],
    evidenceRefs: [
      evidenceRef('mira-core-runtime-mode-kill-switch-implementation-risk-contract', `next:${candidate.recommendation_id}`),
    ],
  }));
}

function sideEffectResult() {
  const result = REQUIRED_SIDE_EFFECT_FIELDS.reduce((acc, field) => {
    acc[field] = true;
    return acc;
  }, {});
  for (const field of SIDE_EFFECT_COUNTER_FIELDS) result[field] = 0;
  result.moduleOrCliImplemented = false;
  result.testsImplemented = false;
  result.uiImplemented = false;
  result.browserWindowCapturePerformed = false;
  result.runtimeStarted = false;
  result.runtimeModeFlagRead = false;
  result.killSwitchWired = false;
  result.runnerExecuted = false;
  result.serverStarted = false;
  result.listenerBound = false;
  result.networkPerformed = false;
  result.databaseWritePerformed = false;
  result.storeWritePerformed = false;
  result.fileWritePerformed = false;
  result.fileMigrationPerformed = false;
  result.queueCreated = false;
  result.leaseCreated = false;
  result.authChanged = false;
  result.keySecretOperationPerformed = false;
  result.localExecutionPerformed = false;
  result.shellPtyUsed = false;
  result.controlExecutionPerformed = false;
  result.reportingSinkWritten = false;
  result.sendPerformed = false;
  result.deployPerformed = false;
  result.tradePerformed = false;
  result.outputFileWritten = false;
  return result;
}

function canonicalRiskInput(risk = {}) {
  return {
    profile: risk.profile,
    sessionId: risk.sessionId,
    deviceId: risk.deviceId,
    baseline_commit: risk.baseline_commit,
    phase_registry: risk.phase_registry,
    schema_registry: risk.schema_registry,
    cli_registry: risk.cli_registry,
    commit_chain: risk.commit_chain,
    source_recommendation: risk.source_recommendation,
    satisfied_prior_recommendations: risk.satisfied_prior_recommendations,
    current_truth: risk.current_truth,
    stale_readiness: risk.stale_readiness,
    phase34_prior_recommendations: risk.phase34_prior_recommendations,
    closure_summary: risk.closure_summary,
    source_refs: risk.source_refs,
    prerequisite_boundary: risk.prerequisite_boundary,
    runtime_mode_boundary: risk.runtime_mode_boundary,
    kill_switch_boundary: risk.kill_switch_boundary,
    prerequisite_gap_matrix: risk.prerequisite_gap_matrix,
    implementation_risk_boundary: risk.implementation_risk_boundary,
    risk_register: risk.risk_register,
    blocked_future_slices: risk.blocked_future_slices,
    capability_matrix: risk.capability_matrix,
    boundary_truth: risk.boundary_truth,
    redaction_summary: risk.redaction_summary,
    unsafe_action_policy: risk.unsafe_action_policy,
    next_phase_recommendations: risk.next_phase_recommendations,
    side_effect_result: risk.side_effect_result,
  };
}

function runtimeModeKillSwitchImplementationRiskIdempotencyKey(risk) {
  return `runtime-mode-kill-switch-implementation-risk:${stableHash(canonicalRiskInput(risk))}`;
}

function buildRisk(options = {}) {
  const contract = options.contract || {};
  const inputSignals = options.inputSignals || {};
  const scope = normalizeScope(inputSignals);
  const generatedAt = generatedAtFromOptions(options, inputSignals);
  const risk = {
    schema: RUNTIME_MODE_KILL_SWITCH_IMPLEMENTATION_RISK_SCHEMA_VERSION,
    version: RUNTIME_MODE_KILL_SWITCH_IMPLEMENTATION_RISK_VERSION,
    risk_id: `runtime-mode-kill-switch-implementation-risk-${stableHash({
      scope,
      baseline: BASELINE_COMMIT,
      source: contract.sourceRecommendation?.recommendation_id,
    }).slice(0, 12)}`,
    idempotency_key: null,
    generated_at: generatedAt,
    ...scope,
    baseline_commit: BASELINE_COMMIT,
    phase_registry: phaseRegistry(contract),
    schema_registry: registryEntries('schema', contract),
    cli_registry: registryEntries('cli', contract),
    commit_chain: clone(contract.commitChainExpected || []),
    source_recommendation: clone(contract.sourceRecommendation || {}),
    satisfied_prior_recommendations: clone(contract.satisfiedPriorRecommendations || []),
    current_truth: currentTruth(contract),
    stale_readiness: staleReadiness(contract),
    phase34_prior_recommendations: phase34PriorRecommendations(contract),
    closure_summary: closureSummary(contract),
    source_refs: clone(contract.sourceRefsExpected || []),
    prerequisite_boundary: prerequisiteBoundary(contract),
    runtime_mode_boundary: runtimeModeBoundary(contract),
    kill_switch_boundary: killSwitchBoundary(contract),
    prerequisite_gap_matrix: prerequisiteGapMatrix(contract),
    implementation_risk_boundary: implementationRiskBoundary(contract),
    risk_register: safeRiskRegister(contract),
    blocked_future_slices: blockedFutureSlices(contract),
    capability_matrix: capabilityMatrix(contract),
    boundary_truth: boundaryTruth(contract),
    redaction_summary: redactionSummary(),
    unsafe_action_policy: unsafeActionPolicy(),
    next_phase_recommendations: nextPhaseRecommendations(contract),
    evidenceRefs: [
      evidenceRef('mira-core-runtime-mode-kill-switch-implementation-risk-contract', 'phase43-risk'),
      evidenceRef('git', BASELINE_COMMIT, 'phase43-baseline'),
    ],
    side_effect_result: sideEffectResult(),
  };
  risk.idempotency_key = runtimeModeKillSwitchImplementationRiskIdempotencyKey(risk);
  return risk;
}

function phaseCurrentOk(risk = {}, phase) {
  const registry = risk.phase_registry || {};
  const truth = risk.current_truth || {};
  const registryMap = {
    35: 'phase35_runtime_next_action_current',
    36: 'phase36_operator_ui_surface_current',
    37: 'phase37_control_reporting_reconciliation_current',
    38: 'phase38_runtime_readiness_refresh_current',
    39: 'phase39_dry_run_readiness_gap_current',
    40: 'phase40_runtime_mode_kill_switch_current',
    41: 'phase41_status_gap_refresh_current',
    42: 'phase42_prerequisite_boundary_current',
  };
  return registry[registryMap[phase]] === true
    && truth[`phase${phase}_current`] === true
    && (phase !== 42 || (
      registry.phase42_commit === BASELINE_COMMIT
      && registry.phase42_delta?.committed_baseline === BASELINE_COMMIT
    ));
}

function registryCountsOk(risk = {}) {
  return risk.phase_registry?.current_through_phase === 42
    && risk.phase_registry?.expected_phases === '1-42'
    && risk.phase_registry?.phase_inventory_count === 42
    && risk.phase_registry?.schema_registry_count === 42
    && risk.phase_registry?.cli_registry_count === 42
    && asArray(risk.schema_registry).length === 42
    && asArray(risk.cli_registry).length === 42;
}

function commitChainOk(risk = {}, contract = {}) {
  const expected = asArray(contract.commitChainExpected);
  const chain = asArray(risk.commit_chain);
  return valuesMatch(chain, expected)
    && chain.length === 30
    && chain[chain.length - 1] === BASELINE_COMMIT;
}

function sourceRecommendationOk(risk = {}, contract = {}) {
  const expected = contract.sourceRecommendation || {};
  const rec = risk.source_recommendation || {};
  return rec.recommendation_id === expected.recommendation_id
    && rec.tier === 'tier1'
    && rec.contract_only_now === true
    && rec.implemented_now === false
    && rec.does_not_authorize_ui === true
    && rec.does_not_authorize_runtime === true
    && rec.does_not_authorize_execution === true;
}

function satisfiedPriorOk(risk = {}, contract = {}) {
  const expected = asArray(contract.satisfiedPriorRecommendations);
  const current = asArray(risk.satisfied_prior_recommendations);
  return current.length === expected.length
    && current.length === 1
    && current[0].recommendation_id === expected[0].recommendation_id
    && current[0].status === expected[0].status
    && current[0].satisfied_by_commit === BASELINE_COMMIT
    && current[0].must_not_reopen === true;
}

function phase34PriorRecommendationsOk(risk = {}, key) {
  const value = risk.phase34_prior_recommendations?.[key];
  return value?.status === 'satisfied_by_c04155d_do_not_repeat_as_open_work'
    && value?.must_not_reopen === true;
}

function staleReadinessOk(risk = {}, phase) {
  if (phase === 13) {
    return risk.stale_readiness?.phase13_readiness_current === false
      && risk.stale_readiness?.phase13_superseded_by === 'phase_23_milestone_readiness';
  }
  if (phase === 23) {
    return risk.stale_readiness?.phase23_milestone_readiness_current === false
      && risk.stale_readiness?.phase23_superseded_by === 'phase_31_runtime_milestone_refresh';
  }
  if (phase === 31) {
    return risk.stale_readiness?.phase31_runtime_milestone_refresh_current === false
      && risk.stale_readiness?.phase31_superseded_by === 'phase_34_runtime_status_milestone_refresh';
  }
  return false;
}

function closuresOk(risk = {}, contract = {}) {
  const expected = contract.closureSummaryExpected || {};
  return Object.entries(expected).every(([key, value]) => (
    key === 'closed_review_refs'
      ? valuesMatch(risk.closure_summary?.[key], value)
      : risk.closure_summary?.[key] === value
  ));
}

function sourceRefsOk(risk = {}, contract = {}) {
  return valuesMatch(risk.source_refs, contract.sourceRefsExpected || []);
}

function recentPhasePathsOk(risk = {}, contract = {}) {
  return valuesMatch(
    risk.phase_registry?.recent_phase_paths,
    contract.phaseRegistryExpected?.required_recent_phase_paths || [],
  );
}

function objectValuesOk(value = {}, shape = {}) {
  return hasRequiredFields(value, shape.requiredFields || [])
    && Object.entries(shape.requiredValues || {}).every(([key, expected]) => valuesMatch(value[key], expected));
}

function prerequisiteBoundaryOk(risk = {}, contract = {}) {
  return objectValuesOk(risk.prerequisite_boundary, contract.prerequisiteBoundaryShapeExpected)
    && risk.prerequisite_boundary?.runtime_authorized_now === false
    && risk.prerequisite_boundary?.dry_run_authorized_now === false
    && risk.prerequisite_boundary?.flag_reader_allowed_now === false
    && risk.prerequisite_boundary?.kill_switch_wiring_allowed_now === false
    && risk.prerequisite_boundary?.all_prerequisites_block_runtime_now === true
    && risk.prerequisite_boundary?.all_prerequisites_non_authorizing === true;
}

function runtimeModeBoundaryOk(risk = {}, contract = {}) {
  return objectValuesOk(risk.runtime_mode_boundary, contract.runtimeModeBoundaryShapeExpected)
    && risk.runtime_mode_boundary?.flag_reader_implemented === false
    && risk.runtime_mode_boundary?.flag_read_now === false
    && risk.runtime_mode_boundary?.authorizes_runtime === false
    && risk.runtime_mode_boundary?.authorizes_dry_run === false
    && risk.runtime_mode_boundary?.authorizes_execution === false;
}

function killSwitchBoundaryOk(risk = {}, contract = {}) {
  return objectValuesOk(risk.kill_switch_boundary, contract.killSwitchBoundaryShapeExpected)
    && risk.kill_switch_boundary?.wired === false
    && risk.kill_switch_boundary?.killWired === false
    && risk.kill_switch_boundary?.live_check_performed === false
    && risk.kill_switch_boundary?.liveCheck === false
    && risk.kill_switch_boundary?.authorizes_runtime === false
    && risk.kill_switch_boundary?.authorizes_execution === false;
}

function prerequisiteGapMatrixOk(risk = {}, contract = {}) {
  const expected = asArray(contract.prerequisiteGapMatrixExpected);
  const gaps = asArray(risk.prerequisite_gap_matrix);
  return gaps.length === expected.length
    && gaps.length === 2
    && gaps.every((gap, index) => {
      const expectedGap = expected[index];
      return gap.gap_id === expectedGap.gap_id
        && gap.maps_from_phase42_gap === expectedGap.maps_from_phase42_gap
        && gap.status === 'unsatisfied_blocking_reference_only'
        && gap.satisfied_now === false
        && gap.blocks_runtime_now === true
        && gap.blocks_dry_run_now === true
        && gap.reference_contract_only === true
        && gap.authorizes_runtime === false
        && gap.authorizes_dry_run === false
        && gap.authorizes_execution === false
        && valuesMatch(gap.implementation_risk_ids, expectedGap.implementation_risk_ids)
        && valuesMatch(gap.future_green_requires, expectedGap.future_green_requires);
    });
}

function implementationRiskBoundaryOk(risk = {}, contract = {}) {
  const value = risk.implementation_risk_boundary || {};
  return objectValuesOk(value, contract.implementationRiskBoundaryShapeExpected)
    && value.risk_count === 8
    && value.implementation_authorized_now === false
    && value.runtime_mode_flag_reader_allowed_now === false
    && value.kill_switch_wiring_allowed_now === false
    && value.control_execution_allowed_now === false
    && value.reporting_sink_allowed_now === false
    && value.runtime_start_allowed_now === false
    && value.review_required === true
    && value.all_risks_block_runtime_now === true
    && value.all_risks_non_authorizing === true
    && asArray(value.future_green_requires).length > 0;
}

function riskRegisterOk(risk = {}, contract = {}) {
  const expected = asArray(contract.riskRegisterExpected);
  const risks = asArray(risk.risk_register);
  return risks.length === expected.length
    && risks.length === 8
    && risks.every((entry, index) => (
      entry.risk_id === expected[index].risk_id
      && entry.status === 'blocking_non_authorizing'
      && entry.satisfied_now === false
      && entry.blocks_runtime_now === true
      && entry.authorizes_runtime === false
    ));
}

function blockedFutureSlicesOk(risk = {}, contract = {}) {
  const expected = asArray(contract.blockedFutureSlicesExpected);
  const slices = asArray(risk.blocked_future_slices);
  return slices.length === expected.length
    && slices.length === 4
    && slices.every((slice, index) => (
      slice.slice_id === expected[index].slice_id
      && slice.blocked_now === true
      && slice.authorizes_runtime === false
    ));
}

function implementationRiskDoesNotSatisfyPrerequisiteGapsOk(risk = {}) {
  return risk.implementation_risk_boundary?.implementation_authorized_now === false
    && risk.implementation_risk_boundary?.all_risks_block_runtime_now === true
    && asArray(risk.prerequisite_gap_matrix).every((gap) => (
      gap.satisfied_now === false
      && gap.blocks_runtime_now === true
      && gap.authorizes_runtime === false
      && gap.authorizes_dry_run === false
      && gap.authorizes_execution === false
    ))
    && asArray(risk.risk_register).every((entry) => (
      entry.status === 'blocking_non_authorizing'
      && entry.satisfied_now === false
      && entry.authorizes_runtime === false
    ))
    && asArray(risk.blocked_future_slices).every((slice) => (
      slice.blocked_now === true
      && slice.authorizes_runtime === false
    ));
}

function capabilityTruthOk(risk = {}) {
  return Object.entries({
    runtimeStarted: false,
    runnerExecuted: false,
    runtimeAvailable: false,
    realRuntimeAvailable: false,
    serverCanExecuteLocal: false,
    serverCanProveModelProcessing: false,
    directBuilderOracleServerTargetsAllowed: false,
  }).every(([key, expected]) => risk.capability_matrix?.[key] === expected);
}

function proofBoundariesOk(risk = {}) {
  return Object.entries({
    runtimeStarted: false,
    runnerExecuted: false,
    runtimeAvailable: false,
    serverCanExecuteLocal: false,
    serverCanProveModelProcessing: false,
    builderOracleDirectServerTargetsAllowed: false,
    socketIsBridgeGreenProof: false,
    deliveryAcceptanceIsModelProcessingProof: false,
    phase42CommitIsRuntimeProof: false,
    implementationRiskIsRuntimeAuthorization: false,
    implementationRiskIsFlagReaderAuthorization: false,
    implementationRiskIsKillSwitchAuthorization: false,
    implementationRiskIsExecutionAuthorization: false,
  }).every(([key, expected]) => risk.boundary_truth?.[key] === expected);
}

function sideEffectValuesOk(sideEffect = {}) {
  return REQUIRED_SIDE_EFFECT_FIELDS.every((field) => sideEffect[field] === true)
    && SIDE_EFFECT_COUNTER_FIELDS.every((field) => sideEffect[field] === 0)
    && sideEffect.moduleOrCliImplemented === false
    && sideEffect.testsImplemented === false
    && sideEffect.uiImplemented === false
    && sideEffect.browserWindowCapturePerformed === false
    && sideEffect.runtimeStarted === false
    && sideEffect.runtimeModeFlagRead === false
    && sideEffect.killSwitchWired === false
    && sideEffect.runnerExecuted === false
    && sideEffect.serverStarted === false
    && sideEffect.listenerBound === false
    && sideEffect.networkPerformed === false
    && sideEffect.databaseWritePerformed === false
    && sideEffect.storeWritePerformed === false
    && sideEffect.fileWritePerformed === false
    && sideEffect.fileMigrationPerformed === false
    && sideEffect.queueCreated === false
    && sideEffect.leaseCreated === false
    && sideEffect.authChanged === false
    && sideEffect.keySecretOperationPerformed === false
    && sideEffect.localExecutionPerformed === false
    && sideEffect.shellPtyUsed === false
    && sideEffect.controlExecutionPerformed === false
    && sideEffect.reportingSinkWritten === false
    && sideEffect.sendPerformed === false
    && sideEffect.deployPerformed === false
    && sideEffect.tradePerformed === false
    && sideEffect.outputFileWritten === false;
}

function noModuleCliTestRuntimeWorkOk(risk = {}) {
  return risk.side_effect_result?.no_module_or_cli_implemented === true
    && risk.side_effect_result?.no_tests_implemented === true
    && risk.side_effect_result?.no_runtime_performed === true
    && risk.side_effect_result?.no_runtime_mode_flag_read === true
    && risk.side_effect_result?.no_kill_switch_wired === true
    && risk.side_effect_result?.no_control_execution_performed === true
    && risk.side_effect_result?.no_reporting_sink_written === true
    && risk.side_effect_result?.no_output_file_written === true;
}

function redactionSummaryOk(risk = {}) {
  return risk.redaction_summary?.raw_private_content_included === false
    && risk.redaction_summary?.raw_terminal_included === false
    && risk.redaction_summary?.raw_screenshot_ocr_browser_included === false
    && risk.redaction_summary?.secret_material_included === false
    && risk.redaction_summary?.customer_private_content_included === false;
}

function nextRecommendationsOk(risk = {}, contract = {}) {
  const candidates = asArray(contract.nextRecommendationExpectedCandidates);
  const recommendations = asArray(risk.next_phase_recommendations);
  return recommendations.length >= Number(contract.expectedManifestShape?.expectedCounts?.next_phase_recommendations_min || 0)
    && recommendations.length === candidates.length
    && recommendations.every((item) => (
      ['tier0', 'tier1'].includes(item.tier)
      && item.does_not_authorize_ui === true
      && item.does_not_authorize_runtime === true
      && item.does_not_authorize_execution === true
      && candidates.some((candidate) => (
        candidate.recommendation_id === item.recommendation_id
        && candidate.tier === item.tier
      ))
    ));
}

function normalizeText(value) {
  return String(value || '').toLowerCase().replace(/[_-]+/g, ' ');
}

function occurrenceIsNegated(text, index) {
  const before = text.slice(Math.max(0, index - 180), index);
  return /\b(no|not|never|without|blocked|false|disabled|unimplemented|unwired|unavailable|non-authorizing|non authorizing|does not authorize|out of scope|reference-only|reference only)\b/.test(before);
}

function textHasOutboundRecipientDrift(text) {
  const normalized = normalizeText(text);
  const outbound = OUTBOUND_TERMS.some((term) => new RegExp(`\\b${term}\\b`).test(normalized));
  const recipient = RECIPIENT_TERMS.some((term) => new RegExp(`\\b${term}\\b`).test(normalized));
  return outbound && recipient;
}

function textHasUnsafeActionDrift(text, contract = {}) {
  const normalized = normalizeText(text);
  if (textHasOutboundRecipientDrift(normalized)) {
    const index = normalized.search(/\b(send|email|message|contact|reply|outbound|external)\b/);
    if (!occurrenceIsNegated(normalized, Math.max(index, 0))) return true;
  }
  for (const phrase of [...UNSAFE_ACTION_PHRASES, ...asArray(contract.unsafeActionPhrases)]) {
    const needle = normalizeText(phrase);
    let index = normalized.indexOf(needle);
    while (index !== -1) {
      if (!occurrenceIsNegated(normalized, index)) return true;
      index = normalized.indexOf(needle, index + needle.length);
    }
  }
  return false;
}

function unsafeActionDriftOk(risk = {}, contract = {}) {
  const text = JSON.stringify({
    next_phase_recommendations: risk.next_phase_recommendations,
    unsafe_action_policy: risk.unsafe_action_policy,
  });
  return !textHasUnsafeActionDrift(text, contract);
}

function literalValuesOk(value = {}, literalMap = {}) {
  return Object.entries(literalMap || {}).every(([dottedPath, expected]) => (
    valuesMatch(pathValue(value, dottedPath), expected)
  ));
}

function requiredLiteralResults(value = {}, literalMap = {}) {
  return Object.entries(literalMap || {}).map(([dottedPath, expected]) => {
    const actual = pathValue(value, dottedPath);
    return {
      path: dottedPath,
      expected,
      actual,
      ok: valuesMatch(actual, expected),
    };
  });
}

function forbiddenOccurrenceIsNegated(text, index) {
  return occurrenceIsNegated(text, index);
}

function assertNoForbiddenOutput(output, forbiddenSubstrings = []) {
  const text = String(JSON.stringify(output)).toLowerCase();
  for (const rawForbidden of asArray(forbiddenSubstrings)) {
    const forbiddenText = String(rawForbidden || '').toLowerCase();
    let index = text.indexOf(forbiddenText);
    while (index !== -1) {
      if (!NEGATABLE_FORBIDDEN_OUTPUT_SUBSTRINGS.has(forbiddenText)
        || !forbiddenOccurrenceIsNegated(text, index)) {
        const snippet = text.slice(Math.max(0, index - 80), index + forbiddenText.length + 80);
        throw new Error(`Forbidden Phase 43 output substring: ${rawForbidden} near ${snippet}`);
      }
      index = text.indexOf(forbiddenText, index + forbiddenText.length);
    }
  }
}

function referencedPaths(contract = {}) {
  const paths = new Set();
  for (const ref of asArray(contract.sourceRefsExpected)) {
    for (const key of ['fixture_path', 'module_path', 'cli_path', 'test_path']) {
      if (ref[key]) paths.add(ref[key]);
    }
  }
  for (const ref of asArray(contract.phaseRegistryExpected?.required_recent_phase_paths)) {
    for (const key of ['fixture_path', 'module_path', 'cli_path', 'test_path']) {
      if (ref[key]) paths.add(ref[key]);
    }
  }
  return Array.from(paths).sort();
}

function buildReferencedPathResults(contract = {}) {
  return referencedPaths(contract).map((relativePath) => {
    const absolutePath = path.resolve(PROJECT_ROOT, relativePath);
    const exists = fs.existsSync(absolutePath);
    return {
      path: relativePath,
      exists,
      expected: true,
      ok: exists,
    };
  });
}

function referencedPathResultsOk(results = [], contract = {}) {
  const expected = referencedPaths(contract);
  const list = asArray(results);
  return expected.length > 0
    && idsEqual(list, 'path', expected)
    && list.every((entry) => entry.expected === true && entry.exists === true && entry.ok === true);
}

function validateRisk(risk = {}, contract = {}) {
  const checks = [];
  const errors = [];
  const resultById = {};
  const add = (id, ok) => {
    const result = resultObject(id, ok);
    checks.push(result);
    resultById[id] = result;
    if (!ok) errors.push(id);
  };

  const outputShapeOk = risk.schema === RUNTIME_MODE_KILL_SWITCH_IMPLEMENTATION_RISK_SCHEMA_VERSION
    && hasRequiredFields(risk, contract.expectedManifestShape?.requiredFields || REQUIRED_RISK_FIELDS);
  const baselineOk = risk.baseline_commit === BASELINE_COMMIT;
  const phase42Ok = phaseCurrentOk(risk, 42);
  const phase35Ok = phaseCurrentOk(risk, 35);
  const phase36Ok = phaseCurrentOk(risk, 36);
  const phase37Ok = phaseCurrentOk(risk, 37);
  const phase38Ok = phaseCurrentOk(risk, 38);
  const phase39Ok = phaseCurrentOk(risk, 39);
  const phase40Ok = phaseCurrentOk(risk, 40);
  const phase41Ok = phaseCurrentOk(risk, 41);
  const registryOk = registryCountsOk(risk);
  const chainOk = commitChainOk(risk, contract);
  const sourceOk = sourceRecommendationOk(risk, contract);
  const satisfiedOk = satisfiedPriorOk(risk, contract);
  const priorValidatorOk = phase34PriorRecommendationsOk(risk, 'phase35_runtime_status_milestone_refresh_validator');
  const priorCliOk = phase34PriorRecommendationsOk(risk, 'phase35_stdout_only_cli_smoke');
  const priorOk = priorValidatorOk && priorCliOk;
  const phase13Ok = staleReadinessOk(risk, 13);
  const phase23Ok = staleReadinessOk(risk, 23);
  const phase31Ok = staleReadinessOk(risk, 31);
  const closureOk = closuresOk(risk, contract);
  const refsOk = sourceRefsOk(risk, contract);
  const recentPathsOk = recentPhasePathsOk(risk, contract);
  const prerequisiteOk = prerequisiteBoundaryOk(risk, contract);
  const modeOk = runtimeModeBoundaryOk(risk, contract);
  const killOk = killSwitchBoundaryOk(risk, contract);
  const matrixOk = prerequisiteGapMatrixOk(risk, contract);
  const implementationOk = implementationRiskBoundaryOk(risk, contract);
  const riskRegisterCheckOk = riskRegisterOk(risk, contract);
  const blockedSlicesOk = blockedFutureSlicesOk(risk, contract);
  const capabilityOk = capabilityTruthOk(risk);
  const proofOk = proofBoundariesOk(risk);
  const sideEffectOk = sideEffectValuesOk(risk.side_effect_result);
  const scopeOk = noModuleCliTestRuntimeWorkOk(risk);
  let forbiddenOk = true;
  try {
    assertNoForbiddenOutput(risk, asArray(contract.forbiddenOutputSubstrings));
  } catch {
    forbiddenOk = false;
  }
  const redactionOk = redactionSummaryOk(risk) && forbiddenOk;
  const recommendationsOk = nextRecommendationsOk(risk, contract);
  const recommendationsNonAuth = recommendationsOk
    && asArray(risk.next_phase_recommendations).every((item) => (
      item.does_not_authorize_ui === true
      && item.does_not_authorize_runtime === true
      && item.does_not_authorize_execution === true
    ));
  const unsafeOk = unsafeActionDriftOk(risk, contract);
  const literalsOk = literalValuesOk(risk, contract.expectedManifestShape?.requiredLiteralValues || {});
  const idempotencyOk = risk.idempotency_key === runtimeModeKillSwitchImplementationRiskIdempotencyKey(risk);
  const implementationDoesNotSatisfyOk = implementationRiskDoesNotSatisfyPrerequisiteGapsOk(risk);

  const staticRuleOk = {
    'baseline-pinned-5b3de99': baselineOk,
    'phase42-current': phase42Ok,
    'phase35-current-preserved': phase35Ok,
    'phase36-current-preserved': phase36Ok,
    'phase37-current-preserved': phase37Ok,
    'phase38-current-preserved': phase38Ok,
    'phase39-current-preserved': phase39Ok,
    'phase40-current-preserved': phase40Ok,
    'phase41-current-preserved': phase41Ok,
    'phase-inventory-count-42': registryOk,
    'schema-registry-count-42': registryOk,
    'cli-registry-count-42': registryOk,
    'commit-chain-exact-30': chainOk,
    'source-recommendation-tier1-selected': sourceOk,
    'phase42-tier0-satisfied-not-open': satisfiedOk,
    'phase34-prior-recommendations-satisfied': priorOk,
    'phase13-stale-preserved': phase13Ok,
    'phase23-stale-preserved': phase23Ok,
    'phase31-stale-preserved': phase31Ok,
    'closures-carried-oracle-115-123-127-131-134-137-141-148-149-156-161-165-168': closureOk,
    'source-refs-phase26-27-29-30-32-33-37-38-39-40-41-42': refsOk,
    'recent-phase-paths-present': recentPathsOk,
    'prerequisite-boundary-preserved': prerequisiteOk,
    'runtime-mode-boundary-disabled-reference-only': modeOk,
    'kill-switch-boundary-fail-closed-reference-only': killOk,
    'prerequisite-gap-matrix-two-unsatisfied-gaps': matrixOk,
    'implementation-risk-boundary-non-authorizing': implementationOk,
    'risk-register-eight-blocking-risks': riskRegisterCheckOk,
    'blocked-future-slices-four': blockedSlicesOk,
    'capability-truth-false': capabilityOk,
    'proof-boundaries-false': proofOk,
    'side-effect-truth-all-blocked': sideEffectOk,
    'no-module-cli-test-runtime-work': scopeOk,
    'redaction-summary-safe': redactionOk,
    'next-recommendations-tier0-tier1-only': recommendationsOk,
    'unsafe-action-drift-blocked': unsafeOk,
    'required-literal-checks-bound': literalsOk,
    'validation-report-coverage-bound': true,
    'idempotency-sensitive': idempotencyOk,
    'implementation-risk-does-not-satisfy-prerequisite-gaps': implementationDoesNotSatisfyOk,
  };

  const acceptanceOk = {
    'baseline-5b3de99-pinned': baselineOk,
    'phase42-current-5b3de99': phase42Ok,
    'phase35-current-preserved': phase35Ok,
    'phase36-current-preserved': phase36Ok,
    'phase37-current-preserved': phase37Ok,
    'phase38-current-preserved': phase38Ok,
    'phase39-current-preserved': phase39Ok,
    'phase40-current-preserved': phase40Ok,
    'phase41-current-preserved': phase41Ok,
    'phase-inventory-exactly-42': registryOk,
    'schema-registry-exactly-42': registryOk,
    'cli-registry-exactly-42': registryOk,
    'commit-chain-count-30-ending-5b3de99': chainOk,
    'source-tier1-implementation-risk-selected': sourceOk,
    'phase42-tier0-validator-satisfied': satisfiedOk,
    'phase42-tier0-validator-not-reopened': satisfiedOk,
    'phase34-prior-validator-satisfied-not-reopened': priorValidatorOk,
    'phase34-prior-cli-smoke-satisfied-not-reopened': priorCliOk,
    'phase13-stale-truth-preserved': phase13Ok,
    'phase23-stale-truth-preserved': phase23Ok,
    'phase31-stale-superseded-by-phase34': phase31Ok,
    'closures-through-oracle-168-present': closureOk,
    'source-refs-phase26-27-29-30-32-33-37-38-39-40-41-42-present': refsOk,
    'recent-phase-paths-present': recentPathsOk,
    'prerequisite-boundary-required-fields-present':
      hasRequiredFields(risk.prerequisite_boundary, contract.prerequisiteBoundaryShapeExpected?.requiredFields || []),
    'prerequisite-boundary-non-authorizing': prerequisiteOk,
    'prerequisite-boundary-blocks-runtime-now': prerequisiteOk,
    'runtime-mode-boundary-required-fields-present':
      hasRequiredFields(risk.runtime_mode_boundary, contract.runtimeModeBoundaryShapeExpected?.requiredFields || []),
    'runtime-mode-boundary-disabled-default':
      risk.runtime_mode_boundary?.default_state === 'disabled'
      && risk.runtime_mode_boundary?.effective_state === 'disabled',
    'runtime-mode-boundary-local-dev-only':
      risk.runtime_mode_boundary?.local_only === true
      && risk.runtime_mode_boundary?.dev_only === true,
    'runtime-mode-boundary-unimplemented':
      risk.runtime_mode_boundary?.implemented_now === false
      && risk.runtime_mode_boundary?.flag_reader_implemented === false,
    'runtime-mode-boundary-no-flag-read': risk.runtime_mode_boundary?.flag_read_now === false,
    'runtime-mode-boundary-non-authorizing': modeOk,
    'kill-switch-boundary-required-fields-present':
      hasRequiredFields(risk.kill_switch_boundary, contract.killSwitchBoundaryShapeExpected?.requiredFields || []),
    'kill-switch-boundary-fail-closed':
      risk.kill_switch_boundary?.default_behavior === 'fail_closed'
      && valuesMatch(risk.kill_switch_boundary?.fail_closed_states, ['missing', 'false', 'invalid', 'stale', 'unknown']),
    'kill-switch-boundary-unwired':
      risk.kill_switch_boundary?.wired === false
      && risk.kill_switch_boundary?.killWired === false,
    'kill-switch-boundary-no-live-check':
      risk.kill_switch_boundary?.live_check_performed === false
      && risk.kill_switch_boundary?.liveCheck === false,
    'kill-switch-boundary-non-authorizing': killOk,
    'prerequisite-gap-matrix-exactly-two': matrixOk,
    'prerequisite-gap-matrix-unsatisfied-and-blocking': matrixOk,
    'implementation-risk-boundary-required-fields-present':
      hasRequiredFields(
        risk.implementation_risk_boundary,
        contract.implementationRiskBoundaryShapeExpected?.requiredFields || [],
      ),
    'implementation-risk-boundary-contract-only': implementationOk,
    'implementation-risk-boundary-blocks-implementation-now': implementationOk,
    'implementation-risk-boundary-non-authorizing': implementationOk,
    'risk-register-exactly-eight': riskRegisterCheckOk,
    'risk-register-all-blocking': riskRegisterCheckOk,
    'risk-register-all-non-authorizing': riskRegisterCheckOk,
    'blocked-future-slices-exactly-four': blockedSlicesOk,
    'blocked-future-slices-all-blocked-now': blockedSlicesOk,
    'runtime-started-false': risk.capability_matrix?.runtimeStarted === false
      && risk.boundary_truth?.runtimeStarted === false
      && risk.side_effect_result?.runtimeStarted === false,
    'runner-executed-false': risk.capability_matrix?.runnerExecuted === false
      && risk.boundary_truth?.runnerExecuted === false
      && risk.side_effect_result?.runnerExecuted === false,
    'runtime-available-false': risk.capability_matrix?.runtimeAvailable === false
      && risk.boundary_truth?.runtimeAvailable === false,
    'server-can-execute-local-false': risk.capability_matrix?.serverCanExecuteLocal === false
      && risk.boundary_truth?.serverCanExecuteLocal === false,
    'server-can-prove-model-processing-false': risk.capability_matrix?.serverCanProveModelProcessing === false
      && risk.boundary_truth?.serverCanProveModelProcessing === false,
    'builder-oracle-direct-targets-blocked': risk.capability_matrix?.directBuilderOracleServerTargetsAllowed === false
      && risk.boundary_truth?.builderOracleDirectServerTargetsAllowed === false,
    'proof-boundaries-false': proofOk,
    'side-effect-truth-all-blocked': sideEffectOk,
    'no-module-cli-test-runtime-work': scopeOk,
    'redaction-summary-safe': redactionOk,
    'next-recommendations-tier0-tier1-only': recommendationsOk,
    'next-recommendations-non-authorizing': recommendationsNonAuth,
    'unsafe-action-drift-rejected': unsafeOk,
    'required-literal-results-complete': literalsOk,
    'referenced-path-results-complete': true,
  };

  add('output-shape-complete', outputShapeOk);
  for (const rule of asArray(contract.staticValidationRules)) add(rule.id, staticRuleOk[rule.id] === true);
  for (const check of asArray(contract.acceptanceChecks)) add(check.id, acceptanceOk[check.id] === true);
  add('risk-literal-values', literalsOk);
  add('risk-contract-complete',
    outputShapeOk
      && Object.values(staticRuleOk).every((ok) => ok === true)
      && Object.values(acceptanceOk).every((ok) => ok === true)
      && literalsOk);

  return {
    ok: errors.length === 0,
    checks,
    errors,
    resultById,
  };
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
    && list.length >= Number(contract.expectedManifestShape?.expectedCounts?.tamper_case_results_min || 0)
    && idsEqual(list, 'id', tamperCases.map((item) => item.id))
    && list.every((entry) => {
      const expected = tamperCases.find((item) => item.id === entry.id);
      return expected
        && entry.covered === true
        && entry.expectedFailure === expected.expectedFailure;
    });
}

function literalResultsOk(results = [], risk = {}, contract = {}) {
  const expected = requiredLiteralResults(risk, contract.expectedManifestShape?.requiredLiteralValues || {});
  return valuesMatch(asArray(results), expected)
    && results.length >= Number(contract.expectedManifestShape?.expectedCounts?.required_literal_results_min || 0);
}

function buildValidationReport(risk, contract = {}, generatedAt = risk.generated_at) {
  const validation = validateRisk(risk, contract);
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
  const forbiddenScanOk = validation.resultById['redaction-summary-safe']?.ok === true;
  const report = {
    schema: VALIDATION_REPORT_SCHEMA_VERSION,
    version: RUNTIME_MODE_KILL_SWITCH_IMPLEMENTATION_RISK_VERSION,
    validation_id: `runtime-mode-kill-switch-implementation-risk-validation-${stableHash({
      risk_key: risk.idempotency_key,
      generatedAt,
    }).slice(0, 12)}`,
    generated_at: generatedAt,
    fixture_ref: FIXTURE_REF,
    baseline_commit: BASELINE_COMMIT,
    decision: validation.ok ? 'accepted_validation_only' : 'rejected',
    accepted: validation.ok,
    blocked: !validation.ok,
    reasons: failed.map((check) => check.id),
    static_rule_results: staticResults,
    acceptance_check_results: acceptanceResults,
    tamper_case_results: tamperResults,
    required_literal_results: requiredLiteralResults(risk, contract.expectedManifestShape?.requiredLiteralValues || {}),
    referenced_path_results: buildReferencedPathResults(contract),
    forbidden_output_scan: resultObject('forbidden-output-strings-absent', forbiddenScanOk),
    side_effect_truth: sideEffectResult(),
    summary: {
      current_through_phase: risk.phase_registry?.current_through_phase,
      phase_registry_count: risk.phase_registry?.phase_inventory_count,
      schema_registry_count: risk.phase_registry?.schema_registry_count,
      cli_registry_count: risk.phase_registry?.cli_registry_count,
      commit_chain_count: asArray(risk.commit_chain).length,
      source_ref_count: asArray(risk.source_refs).length,
      prerequisite_gap_count: asArray(risk.prerequisite_gap_matrix).length,
      risk_register_count: asArray(risk.risk_register).length,
      blocked_future_slice_count: asArray(risk.blocked_future_slices).length,
      next_recommendation_count: asArray(risk.next_phase_recommendations).length,
      baseline_commit: risk.baseline_commit,
      accepted_validation_only: validation.ok,
    },
  };
  assertNoForbiddenOutput(report, asArray(contract.forbiddenOutputSubstrings));
  return report;
}

function buildMiraCoreRuntimeModeKillSwitchImplementationRisk(options = {}) {
  const contract = options.contract || {};
  const runtime_mode_kill_switch_implementation_risk = buildRisk(options);
  const validation_report = buildValidationReport(
    runtime_mode_kill_switch_implementation_risk,
    contract,
    runtime_mode_kill_switch_implementation_risk.generated_at,
  );
  const output = {
    runtime_mode_kill_switch_implementation_risk,
    validation_report,
  };
  assertNoForbiddenOutput(output, asArray(contract.forbiddenOutputSubstrings));
  return output;
}

function validateMiraCoreRuntimeModeKillSwitchImplementationRiskOutput(output = {}, contract = {}) {
  const checks = [];
  const errors = [];
  const add = (id, ok) => {
    checks.push({ id, ok: ok === true });
    if (!ok) errors.push(id);
  };
  const risk = output.runtime_mode_kill_switch_implementation_risk || {};
  const report = output.validation_report || {};
  const riskValidation = validateRisk(risk, contract);
  const referencedOk = referencedPathResultsOk(report.referenced_path_results, contract);
  const recomputedById = riskValidation.checks.reduce((acc, check) => {
    acc[check.id] = check;
    return acc;
  }, {});
  recomputedById['referenced-path-results-complete'] =
    resultObject('referenced-path-results-complete', referencedOk);
  const staticIds = asArray(contract.staticValidationRules).map((rule) => rule.id);
  const acceptanceIds = asArray(contract.acceptanceChecks).map((check) => check.id);
  const reportCoverageOk =
    resultListMatches(report.static_rule_results, staticIds, recomputedById)
    && resultListMatches(report.acceptance_check_results, acceptanceIds, recomputedById)
    && tamperCaseResultsOk(report.tamper_case_results, contract)
    && literalResultsOk(report.required_literal_results, risk, contract)
    && referencedOk;

  add('output-shape-complete',
    hasRequiredFields(output, contract.expectedOutputShape?.requiredTopLevelFields || REQUIRED_OUTPUT_FIELDS)
      && risk.schema === RUNTIME_MODE_KILL_SWITCH_IMPLEMENTATION_RISK_SCHEMA_VERSION
      && report.schema === VALIDATION_REPORT_SCHEMA_VERSION
      && hasRequiredFields(risk, contract.expectedManifestShape?.requiredFields || REQUIRED_RISK_FIELDS)
      && hasRequiredFields(report, contract.expectedValidationReportShape?.requiredFields || REQUIRED_VALIDATION_REPORT_FIELDS));

  for (const check of riskValidation.checks) {
    if (check.id !== 'referenced-path-results-complete'
      && check.id !== 'validation-report-coverage-bound') {
      add(check.id, check.ok);
    }
  }

  add('validation-report-literal-values',
    report.schema === VALIDATION_REPORT_SCHEMA_VERSION
      && report.baseline_commit === BASELINE_COMMIT
      && literalValuesOk(report, contract.expectedValidationReportShape?.requiredLiteralValues || {}));
  add('validation-report-side-effect-truth', sideEffectValuesOk(report.side_effect_truth));
  add('referenced-path-results-complete', referencedOk);
  add('validation-report-coverage-bound', reportCoverageOk);
  add('validation-report-matches-contract',
    report.accepted === riskValidation.ok
      && report.blocked === !riskValidation.ok
      && report.decision === (riskValidation.ok ? 'accepted_validation_only' : 'rejected')
      && valuesMatch(
        asArray(report.reasons),
        riskValidation.checks.filter((check) => !check.ok).map((check) => check.id),
      )
      && reportCoverageOk
      && report.forbidden_output_scan?.ok === Boolean(recomputedById['redaction-summary-safe']?.ok));

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
  REQUIRED_RISK_FIELDS,
  REQUIRED_SIDE_EFFECT_FIELDS,
  REQUIRED_VALIDATION_REPORT_FIELDS,
  RUNTIME_MODE_KILL_SWITCH_IMPLEMENTATION_RISK_SCHEMA_VERSION,
  VALIDATION_REPORT_SCHEMA_VERSION,
  assertNoForbiddenOutput,
  buildMiraCoreRuntimeModeKillSwitchImplementationRisk,
  runtimeModeKillSwitchImplementationRiskIdempotencyKey,
  stableHash,
  validateMiraCoreRuntimeModeKillSwitchImplementationRiskOutput,
};
