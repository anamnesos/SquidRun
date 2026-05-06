'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const RUNTIME_MODE_KILL_SWITCH_PREREQUISITE_BOUNDARY_SCHEMA_VERSION =
  'squidrun.mira_core.runtime_mode_kill_switch_prerequisite_boundary.v0';
const VALIDATION_REPORT_SCHEMA_VERSION =
  'squidrun.mira_core.runtime_mode_kill_switch_prerequisite_boundary_validation_report.v0';
const RUNTIME_MODE_KILL_SWITCH_PREREQUISITE_BOUNDARY_VERSION = 'v0';
const BASELINE_COMMIT = '833f9c1';
const FIXTURE_REF =
  'ui/__tests__/fixtures/mira-core-runtime-mode-kill-switch-prerequisite-boundary-contract.json';

const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');

const REQUIRED_OUTPUT_FIELDS = Object.freeze([
  'runtime_mode_kill_switch_prerequisite_boundary',
  'validation_report',
]);

const REQUIRED_BOUNDARY_FIELDS = Object.freeze([
  'schema',
  'version',
  'boundary_id',
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
  'ui rendered',
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
  'PTY executed',
  'customer send performed',
  'external send performed',
  'deploy performed',
  'trade performed',
  'output file written',
  'phase41 commit proves runtime',
  'prerequisite boundary authorizes runtime',
  'runtime mode boundary authorizes runtime',
  'kill switch boundary authorizes runtime',
  'kill switch boundary authorizes execution',
  'socket proves bridge green',
  'delivery acceptance proves model processing',
  'Builder direct target allowed',
  'Oracle direct target allowed',
]);

const NEGATABLE_FORBIDDEN_OUTPUT_SUBSTRINGS = Object.freeze(new Set([
  'ui rendered',
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
  'phase41 commit proves runtime',
  'prerequisite boundary authorizes runtime',
  'runtime mode boundary authorizes runtime',
  'kill switch boundary authorizes runtime',
  'kill switch boundary authorizes execution',
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

function asPathParts(dottedPath) {
  return String(dottedPath || '').split('.');
}

function pathValue(value, dottedPath) {
  return asPathParts(dottedPath).reduce((acc, key) => (
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

function evidenceRef(store, eventId, relation = 'runtime_mode_kill_switch_prerequisite_boundary_validation') {
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
    sessionId: inputSignals.sessionId || 'session-342',
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
    current_through_phase: 41,
    expected_phases: expected.expected_phases || '1-41',
    phase_inventory_count: 41,
    schema_registry_count: 41,
    cli_registry_count: 41,
    phase35_runtime_next_action_current: true,
    phase36_operator_ui_surface_current: true,
    phase37_control_reporting_reconciliation_current: true,
    phase38_runtime_readiness_refresh_current: true,
    phase39_dry_run_readiness_gap_current: true,
    phase40_runtime_mode_kill_switch_current: true,
    phase41_status_gap_refresh_current: true,
    phase41_commit: BASELINE_COMMIT,
    phase41_delta: clone(expected.phase41_delta || {}),
    recent_phase_paths: clone(expected.required_recent_phase_paths || []),
    evidenceRefs: [
      evidenceRef('git', BASELINE_COMMIT, 'phase42-baseline'),
      evidenceRef('mira-core-runtime-mode-kill-switch-prerequisite-boundary-contract', 'phase-registry'),
    ],
  };
}

function registryEntries(kind, contract = {}) {
  const recent = new Map(asArray(contract.phaseRegistryExpected?.required_recent_phase_paths)
    .map((entry) => [entry.phase, entry]));
  return Array.from({ length: 41 }, (_, index) => {
    const phase = index + 1;
    const recentEntry = recent.get(phase);
    return {
      phase,
      registry_kind: kind,
      artifact_id: recentEntry ? `phase${phase}-${kind}` : `phase${phase}-${kind}-registered`,
      status: phase <= 41 ? 'registered_validation_artifact' : 'unknown',
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
      evidenceRef('git', BASELINE_COMMIT, 'phase41-current'),
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
    source_ref: 'phase41-runtime-mode-kill-switch-status-gap-refresh',
    ...clone(contract.runtimeModeBoundaryShapeExpected?.requiredValues || {}),
    evidenceRefs: [
      evidenceRef('mira-core-runtime-mode-kill-switch-status-gap-refresh-contract', 'runtime-mode-boundary'),
      evidenceRef('git', BASELINE_COMMIT, 'runtime-mode-boundary-baseline'),
    ],
  };
}

function killSwitchBoundary(contract = {}) {
  return {
    source_ref: 'phase41-runtime-mode-kill-switch-status-gap-refresh',
    ...clone(contract.killSwitchBoundaryShapeExpected?.requiredValues || {}),
    evidenceRefs: [
      evidenceRef('mira-core-runtime-mode-kill-switch-status-gap-refresh-contract', 'kill-switch-boundary'),
      evidenceRef('git', BASELINE_COMMIT, 'kill-switch-boundary-baseline'),
    ],
  };
}

function prerequisiteGapMatrix(contract = {}) {
  return asArray(contract.prerequisiteGapMatrixExpected).map((gap) => ({
    ...clone(gap),
    authorizes_execution: false,
    evidenceRefs: [
      evidenceRef('mira-core-runtime-mode-kill-switch-prerequisite-boundary-contract', gap.gap_id),
    ],
  }));
}

function capabilityMatrix(contract = {}) {
  return {
    ...clone(contract.capabilityMatrixExpected || {}),
    evidenceRefs: [evidenceRef('mira-core-runtime-mode-kill-switch-prerequisite-boundary-contract', 'capability-matrix')],
  };
}

function boundaryTruth(contract = {}) {
  return {
    ...clone(contract.proofBoundaryExpected || {}),
    evidenceRefs: [evidenceRef('mira-core-runtime-mode-kill-switch-prerequisite-boundary-contract', 'boundary-truth')],
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
      evidenceRef('mira-core-runtime-mode-kill-switch-prerequisite-boundary-contract', 'redaction-summary'),
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
      evidenceRef('mira-core-runtime-mode-kill-switch-prerequisite-boundary-contract', 'unsafe-action-policy'),
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
      evidenceRef('mira-core-runtime-mode-kill-switch-prerequisite-boundary-contract', `next:${candidate.recommendation_id}`),
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

function canonicalBoundaryInput(boundary = {}) {
  return {
    profile: boundary.profile,
    sessionId: boundary.sessionId,
    deviceId: boundary.deviceId,
    baseline_commit: boundary.baseline_commit,
    phase_registry: boundary.phase_registry,
    schema_registry: boundary.schema_registry,
    cli_registry: boundary.cli_registry,
    commit_chain: boundary.commit_chain,
    source_recommendation: boundary.source_recommendation,
    satisfied_prior_recommendations: boundary.satisfied_prior_recommendations,
    current_truth: boundary.current_truth,
    stale_readiness: boundary.stale_readiness,
    phase34_prior_recommendations: boundary.phase34_prior_recommendations,
    closure_summary: boundary.closure_summary,
    source_refs: boundary.source_refs,
    prerequisite_boundary: boundary.prerequisite_boundary,
    runtime_mode_boundary: boundary.runtime_mode_boundary,
    kill_switch_boundary: boundary.kill_switch_boundary,
    prerequisite_gap_matrix: boundary.prerequisite_gap_matrix,
    capability_matrix: boundary.capability_matrix,
    boundary_truth: boundary.boundary_truth,
    redaction_summary: boundary.redaction_summary,
    unsafe_action_policy: boundary.unsafe_action_policy,
    next_phase_recommendations: boundary.next_phase_recommendations,
    side_effect_result: boundary.side_effect_result,
  };
}

function runtimeModeKillSwitchPrerequisiteBoundaryIdempotencyKey(boundary) {
  return `runtime-mode-kill-switch-prerequisite-boundary:${stableHash(canonicalBoundaryInput(boundary))}`;
}

function buildBoundary(options = {}) {
  const contract = options.contract || {};
  const inputSignals = options.inputSignals || {};
  const scope = normalizeScope(inputSignals);
  const generatedAt = generatedAtFromOptions(options, inputSignals);
  const boundary = {
    schema: RUNTIME_MODE_KILL_SWITCH_PREREQUISITE_BOUNDARY_SCHEMA_VERSION,
    version: RUNTIME_MODE_KILL_SWITCH_PREREQUISITE_BOUNDARY_VERSION,
    boundary_id: `runtime-mode-kill-switch-prerequisite-boundary-${stableHash({
      profile: scope.profile,
      sessionId: scope.sessionId,
      deviceId: scope.deviceId,
      baseline: BASELINE_COMMIT,
    }).slice(0, 12)}`,
    idempotency_key: null,
    generated_at: generatedAt,
    profile: scope.profile,
    sessionId: scope.sessionId,
    deviceId: scope.deviceId,
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
    capability_matrix: capabilityMatrix(contract),
    boundary_truth: boundaryTruth(contract),
    redaction_summary: redactionSummary(),
    unsafe_action_policy: unsafeActionPolicy(),
    next_phase_recommendations: nextPhaseRecommendations(contract),
    evidenceRefs: [
      evidenceRef('git', BASELINE_COMMIT, 'phase42-baseline'),
      evidenceRef('mira-core-runtime-mode-kill-switch-prerequisite-boundary-contract', 'phase42-contract'),
    ],
    side_effect_result: sideEffectResult(),
  };
  boundary.idempotency_key = runtimeModeKillSwitchPrerequisiteBoundaryIdempotencyKey(boundary);
  return boundary;
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
      expected: clone(expected),
      actual: clone(actual),
      ok: valuesMatch(actual, expected),
    };
  });
}

function requiredValuesObjectOk(actual = {}, expected = {}, requiredFields = []) {
  return hasRequiredFields(actual, requiredFields)
    && Object.entries(expected || {}).every(([key, value]) => valuesMatch(actual[key], value));
}

function phaseCurrentOk(boundary = {}, phase) {
  const truth = boundary.current_truth || {};
  const registry = boundary.phase_registry || {};
  if (phase === 41) {
    return truth.phase41_current === true
      && truth.phase41_commit === BASELINE_COMMIT
      && registry.phase41_status_gap_refresh_current === true
      && registry.phase41_commit === BASELINE_COMMIT;
  }
  return truth[`phase${phase}_current`] === true
    && registry[`phase${phase}_runtime_next_action_current`] !== false
    && registry[`phase${phase}_operator_ui_surface_current`] !== false
    && registry[`phase${phase}_control_reporting_reconciliation_current`] !== false
    && registry[`phase${phase}_runtime_readiness_refresh_current`] !== false
    && registry[`phase${phase}_dry_run_readiness_gap_current`] !== false
    && registry[`phase${phase}_runtime_mode_kill_switch_current`] !== false;
}

function registryCountsOk(boundary = {}) {
  const registry = boundary.phase_registry || {};
  return registry.current_through_phase === 41
    && registry.expected_phases === '1-41'
    && registry.phase_inventory_count === 41
    && registry.schema_registry_count === 41
    && registry.cli_registry_count === 41
    && asArray(boundary.schema_registry).length === 41
    && asArray(boundary.cli_registry).length === 41;
}

function commitChainOk(boundary = {}, contract = {}) {
  const expected = asArray(contract.commitChainExpected);
  const actual = asArray(boundary.commit_chain);
  return valuesMatch(actual, expected)
    && actual.length === 29
    && actual[actual.length - 1] === BASELINE_COMMIT;
}

function sourceRecommendationOk(boundary = {}, contract = {}) {
  const expected = contract.sourceRecommendation || {};
  const actual = boundary.source_recommendation || {};
  return actual.recommendation_id === expected.recommendation_id
    && actual.tier === 'tier1'
    && actual.status === expected.status
    && actual.contract_only_now === true
    && actual.implemented_now === false
    && actual.does_not_authorize_ui === true
    && actual.does_not_authorize_runtime === true
    && actual.does_not_authorize_execution === true;
}

function satisfiedPriorOk(boundary = {}, contract = {}) {
  const expected = asArray(contract.satisfiedPriorRecommendations);
  const actual = asArray(boundary.satisfied_prior_recommendations);
  return actual.length === expected.length
    && expected.length === 1
    && actual[0]?.recommendation_id === expected[0]?.recommendation_id
    && actual[0]?.status === 'satisfied_by_833f9c1_do_not_repeat_as_open_work'
    && actual[0]?.satisfied_by_commit === BASELINE_COMMIT
    && actual[0]?.must_not_reopen === true
    && !asArray(boundary.next_phase_recommendations).some((item) => (
      item.recommendation_id === actual[0]?.recommendation_id
    ));
}

function phase34PriorRecommendationsOk(boundary = {}, key) {
  const entry = boundary.phase34_prior_recommendations?.[key];
  return entry?.status === 'satisfied_by_c04155d_do_not_repeat_as_open_work'
    && entry?.must_not_reopen === true;
}

function staleReadinessOk(boundary = {}, phase) {
  const stale = boundary.stale_readiness || {};
  if (phase === 13) {
    return stale.phase13_readiness_current === false
      && stale.phase13_superseded_by === 'phase_23_milestone_readiness';
  }
  if (phase === 23) {
    return stale.phase23_milestone_readiness_current === false
      && stale.phase23_superseded_by === 'phase_31_runtime_milestone_refresh';
  }
  if (phase === 31) {
    return stale.phase31_runtime_milestone_refresh_current === false
      && stale.phase31_superseded_by === 'phase_34_runtime_status_milestone_refresh';
  }
  return false;
}

function closuresOk(boundary = {}, contract = {}) {
  const expected = contract.closureSummaryExpected || {};
  return asArray(expected.closed_review_refs).every((ref) => (
    asArray(boundary.closure_summary?.closed_review_refs).includes(ref)
  ))
    && Object.entries(expected).every(([key, value]) => (
      key === 'closed_review_refs' || boundary.closure_summary?.[key] === value
    ));
}

function sourceRefsOk(boundary = {}, contract = {}) {
  return valuesMatch(boundary.source_refs, contract.sourceRefsExpected || [])
    && asArray(boundary.source_refs).length === 11;
}

function recentPhasePathsOk(boundary = {}, contract = {}) {
  return valuesMatch(
    boundary.phase_registry?.recent_phase_paths,
    contract.phaseRegistryExpected?.required_recent_phase_paths || [],
  );
}

function prerequisiteBoundaryOk(boundary = {}, contract = {}) {
  const shape = contract.prerequisiteBoundaryShapeExpected || {};
  const item = boundary.prerequisite_boundary || {};
  return requiredValuesObjectOk(item, shape.requiredValues || {}, shape.requiredFields || [])
    && item.decision === 'remain_prerequisite_boundary_contract_only'
    && item.prerequisite_count === 2
    && item.runtime_mode_prerequisite_satisfied_now === false
    && item.kill_switch_prerequisite_satisfied_now === false
    && item.runtime_authorized_now === false
    && item.dry_run_authorized_now === false
    && item.flag_reader_allowed_now === false
    && item.kill_switch_wiring_allowed_now === false
    && item.all_prerequisites_block_runtime_now === true
    && item.all_prerequisites_non_authorizing === true;
}

function runtimeModeBoundaryOk(boundary = {}, contract = {}) {
  const shape = contract.runtimeModeBoundaryShapeExpected || {};
  const mode = boundary.runtime_mode_boundary || {};
  return requiredValuesObjectOk(mode, shape.requiredValues || {}, shape.requiredFields || [])
    && mode.source_ref === 'phase41-runtime-mode-kill-switch-status-gap-refresh'
    && mode.status === 'disabled_reference_only_prerequisite'
    && mode.default_state === 'disabled'
    && mode.effective_state === 'disabled'
    && mode.local_only === true
    && mode.dev_only === true
    && mode.reference_only === true
    && mode.implemented_now === false
    && mode.flag_reader_implemented === false
    && mode.flag_read_now === false
    && mode.authorizes_runtime === false
    && mode.authorizes_dry_run === false
    && mode.authorizes_execution === false;
}

function killSwitchBoundaryOk(boundary = {}, contract = {}) {
  const shape = contract.killSwitchBoundaryShapeExpected || {};
  const status = boundary.kill_switch_boundary || {};
  return requiredValuesObjectOk(status, shape.requiredValues || {}, shape.requiredFields || [])
    && status.source_ref === 'phase41-runtime-mode-kill-switch-status-gap-refresh'
    && status.status === 'fail_closed_reference_only_prerequisite'
    && status.default_behavior === 'fail_closed'
    && status.visible_to_operator === true
    && status.reference_only === true
    && status.implemented_now === false
    && status.wired === false
    && status.killWired === false
    && status.live_check_performed === false
    && status.liveCheck === false
    && status.authorizes_runtime === false
    && status.authorizes_execution === false;
}

function prerequisiteGapMatrixOk(boundary = {}, contract = {}) {
  const expected = asArray(contract.prerequisiteGapMatrixExpected);
  const actual = asArray(boundary.prerequisite_gap_matrix);
  return actual.length === expected.length
    && expected.length === 2
    && actual.every((gap, index) => {
      const expectedGap = expected[index];
      return gap.gap_id === expectedGap.gap_id
        && gap.maps_from_phase41_gap === expectedGap.maps_from_phase41_gap
        && gap.status === 'unsatisfied_blocking_reference_only'
        && gap.satisfied_now === false
        && gap.blocks_runtime_now === true
        && gap.blocks_dry_run_now === true
        && gap.reference_contract_only === true
        && gap.authorizes_runtime === false
        && gap.authorizes_dry_run === false
        && gap.authorizes_execution === false
        && valuesMatch(gap.future_green_requires, expectedGap.future_green_requires);
    });
}

function prerequisiteBoundaryDoesNotSatisfyGapsOk(boundary = {}) {
  return prerequisiteBoundaryOk(boundary, {})
    && asArray(boundary.prerequisite_gap_matrix).every((gap) => (
      gap.satisfied_now === false
      && gap.blocks_runtime_now === true
      && gap.blocks_dry_run_now === true
      && gap.authorizes_runtime === false
      && gap.authorizes_dry_run === false
      && gap.authorizes_execution === false
    ));
}

function capabilityTruthOk(boundary = {}) {
  return [
    'runtimeStarted',
    'runnerExecuted',
    'runtimeAvailable',
    'realRuntimeAvailable',
    'serverCanExecuteLocal',
    'serverCanProveModelProcessing',
    'directBuilderOracleServerTargetsAllowed',
  ].every((key) => boundary.capability_matrix?.[key] === false);
}

function proofBoundariesOk(boundary = {}) {
  return [
    'runtimeStarted',
    'runnerExecuted',
    'runtimeAvailable',
    'serverCanExecuteLocal',
    'serverCanProveModelProcessing',
    'builderOracleDirectServerTargetsAllowed',
    'socketIsBridgeGreenProof',
    'deliveryAcceptanceIsModelProcessingProof',
    'phase41CommitIsRuntimeProof',
    'prerequisiteBoundaryIsRuntimeAuthorization',
    'runtimeModeBoundaryIsRuntimeAuthorization',
    'killSwitchBoundaryIsRuntimeAuthorization',
    'killSwitchBoundaryIsExecutionAuthorization',
  ].every((key) => boundary.boundary_truth?.[key] === false);
}

function sideEffectValuesOk(sideEffects = {}) {
  return REQUIRED_SIDE_EFFECT_FIELDS.every((field) => sideEffects[field] === true)
    && SIDE_EFFECT_COUNTER_FIELDS.every((field) => sideEffects[field] === 0)
    && [
      'moduleOrCliImplemented',
      'testsImplemented',
      'uiImplemented',
      'browserWindowCapturePerformed',
      'runtimeStarted',
      'runtimeModeFlagRead',
      'killSwitchWired',
      'runnerExecuted',
      'serverStarted',
      'listenerBound',
      'networkPerformed',
      'databaseWritePerformed',
      'storeWritePerformed',
      'fileWritePerformed',
      'fileMigrationPerformed',
      'queueCreated',
      'leaseCreated',
      'authChanged',
      'keySecretOperationPerformed',
      'localExecutionPerformed',
      'shellPtyUsed',
      'controlExecutionPerformed',
      'reportingSinkWritten',
      'sendPerformed',
      'deployPerformed',
      'tradePerformed',
      'outputFileWritten',
    ].every((field) => sideEffects[field] === false);
}

function noModuleCliTestRuntimeWorkOk(boundary = {}) {
  const effects = boundary.side_effect_result || {};
  return effects.no_module_or_cli_implemented === true
    && effects.no_tests_implemented === true
    && effects.no_runtime_performed === true
    && effects.no_runtime_mode_flag_read === true
    && effects.no_kill_switch_wired === true
    && effects.no_control_execution_performed === true
    && effects.no_reporting_sink_written === true
    && effects.no_output_file_written === true
    && effects.moduleOrCliImplemented === false
    && effects.testsImplemented === false
    && effects.runtimeModeFlagRead === false
    && effects.killSwitchWired === false
    && effects.controlExecutionPerformed === false
    && effects.reportingSinkWritten === false
    && effects.outputFileWritten === false;
}

function redactionSummaryOk(boundary = {}) {
  const summary = boundary.redaction_summary || {};
  return summary.raw_private_content_included === false
    && summary.raw_terminal_included === false
    && summary.raw_screenshot_ocr_browser_included === false
    && summary.secret_material_included === false
    && summary.customer_private_content_included === false;
}

function nextRecommendationsOk(boundary = {}, contract = {}) {
  const recommendations = asArray(boundary.next_phase_recommendations);
  const expected = asArray(contract.nextRecommendationExpectedCandidates);
  return recommendations.length >= 2
    && recommendations.length === expected.length
    && expected.every((candidate) => recommendations.some((item) => (
      item.recommendation_id === candidate.recommendation_id
      && item.tier === candidate.tier
      && item.action === candidate.action
      && item.why_safe === candidate.why_safe
      && item.does_not_authorize_ui === true
      && item.does_not_authorize_runtime === true
      && item.does_not_authorize_execution === true
    )))
    && recommendations.every((item) => (
      ['tier0', 'tier1'].includes(item.tier)
      && item.does_not_authorize_ui === true
      && item.does_not_authorize_runtime === true
      && item.does_not_authorize_execution === true
    ));
}

function collectStringValues(value, strings = []) {
  if (typeof value === 'string') strings.push(value);
  if (Array.isArray(value)) value.forEach((item) => collectStringValues(item, strings));
  if (value && typeof value === 'object') {
    Object.values(value).forEach((item) => collectStringValues(item, strings));
  }
  return strings;
}

function occurrenceIsNegated(text, index) {
  const start = Math.max(0, index - 180);
  const end = Math.min(text.length, index + 140);
  const context = text.slice(start, end);
  return /\b(no|not|never|without|blocked|disabled|false|unavailable|non-authorizing|non authorizing|reference-only|reference only|contract-only|contract only|future|later|before|keeps|remain|prevents|does not|do not|must not|unwired|unimplemented)\b/.test(context);
}

function containsUnsafeRecipientIntent(text) {
  const lower = String(text || '').toLowerCase();
  const hasOutbound = OUTBOUND_TERMS.some((term) => new RegExp(`\\b${term}\\b`).test(lower));
  const hasRecipient = RECIPIENT_TERMS.some((term) => new RegExp(`\\b${term}\\b`).test(lower));
  if (!hasOutbound || !hasRecipient) return false;
  const index = Math.min(
    ...[...OUTBOUND_TERMS, ...RECIPIENT_TERMS]
      .map((term) => lower.search(new RegExp(`\\b${term}\\b`)))
      .filter((found) => found >= 0),
  );
  return !occurrenceIsNegated(lower, Math.max(0, index));
}

function unsafeActionDriftOk(boundary = {}, contract = {}) {
  const phrases = new Set([
    ...UNSAFE_ACTION_PHRASES,
    ...asArray(contract.unsafeActionPhrases),
  ].map((phrase) => String(phrase).toLowerCase()));
  for (const raw of collectStringValues(boundary)) {
    const text = String(raw).toLowerCase();
    if (containsUnsafeRecipientIntent(text)) return false;
    for (const phrase of phrases) {
      let index = text.indexOf(phrase);
      while (index !== -1) {
        if (!occurrenceIsNegated(text, index)) return false;
        index = text.indexOf(phrase, index + phrase.length);
      }
    }
  }
  return true;
}

function assertNoForbiddenOutput(output, fixtureForbiddenSubstrings = []) {
  const forbidden = new Set([
    ...DEFAULT_FORBIDDEN_OUTPUT_SUBSTRINGS,
    ...asArray(fixtureForbiddenSubstrings),
  ].map((item) => String(item).toLowerCase()));
  const strings = collectStringValues(output);
  for (const forbiddenText of forbidden) {
    for (const raw of strings) {
      const text = String(raw).toLowerCase();
      let index = text.indexOf(forbiddenText);
      while (index !== -1) {
        if (!NEGATABLE_FORBIDDEN_OUTPUT_SUBSTRINGS.has(forbiddenText)
          || !occurrenceIsNegated(text, index)) {
          throw new Error(`runtime_mode_kill_switch_prerequisite_boundary_forbidden_substring:${forbiddenText}`);
        }
        index = text.indexOf(forbiddenText, index + forbiddenText.length);
      }
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

function validateBoundary(boundary = {}, contract = {}) {
  const checks = [];
  const errors = [];
  const resultById = {};
  const add = (id, ok) => {
    const result = resultObject(id, ok);
    checks.push(result);
    resultById[id] = result;
    if (!ok) errors.push(id);
  };

  const outputShapeOk = boundary.schema === RUNTIME_MODE_KILL_SWITCH_PREREQUISITE_BOUNDARY_SCHEMA_VERSION
    && hasRequiredFields(boundary, contract.expectedManifestShape?.requiredFields || REQUIRED_BOUNDARY_FIELDS);
  const baselineOk = boundary.baseline_commit === BASELINE_COMMIT;
  const phase41Ok = phaseCurrentOk(boundary, 41);
  const phase35Ok = phaseCurrentOk(boundary, 35);
  const phase36Ok = phaseCurrentOk(boundary, 36);
  const phase37Ok = phaseCurrentOk(boundary, 37);
  const phase38Ok = phaseCurrentOk(boundary, 38);
  const phase39Ok = phaseCurrentOk(boundary, 39);
  const phase40Ok = phaseCurrentOk(boundary, 40);
  const registryOk = registryCountsOk(boundary);
  const chainOk = commitChainOk(boundary, contract);
  const sourceOk = sourceRecommendationOk(boundary, contract);
  const satisfiedOk = satisfiedPriorOk(boundary, contract);
  const priorValidatorOk = phase34PriorRecommendationsOk(boundary, 'phase35_runtime_status_milestone_refresh_validator');
  const priorCliOk = phase34PriorRecommendationsOk(boundary, 'phase35_stdout_only_cli_smoke');
  const priorOk = priorValidatorOk && priorCliOk;
  const phase13Ok = staleReadinessOk(boundary, 13);
  const phase23Ok = staleReadinessOk(boundary, 23);
  const phase31Ok = staleReadinessOk(boundary, 31);
  const closureOk = closuresOk(boundary, contract);
  const refsOk = sourceRefsOk(boundary, contract);
  const recentPathsOk = recentPhasePathsOk(boundary, contract);
  const prerequisiteOk = prerequisiteBoundaryOk(boundary, contract);
  const modeOk = runtimeModeBoundaryOk(boundary, contract);
  const killOk = killSwitchBoundaryOk(boundary, contract);
  const matrixOk = prerequisiteGapMatrixOk(boundary, contract);
  const gapsUnsatisfiedOk = prerequisiteBoundaryDoesNotSatisfyGapsOk(boundary);
  const capabilityOk = capabilityTruthOk(boundary);
  const proofOk = proofBoundariesOk(boundary);
  const sideEffectOk = sideEffectValuesOk(boundary.side_effect_result);
  const scopeOk = noModuleCliTestRuntimeWorkOk(boundary);
  let forbiddenOk = true;
  try {
    assertNoForbiddenOutput(boundary, asArray(contract.forbiddenOutputSubstrings));
  } catch {
    forbiddenOk = false;
  }
  const redactionOk = redactionSummaryOk(boundary) && forbiddenOk;
  const recommendationsOk = nextRecommendationsOk(boundary, contract);
  const recommendationsNonAuth = recommendationsOk
    && asArray(boundary.next_phase_recommendations).every((item) => (
      item.does_not_authorize_ui === true
      && item.does_not_authorize_runtime === true
      && item.does_not_authorize_execution === true
    ));
  const unsafeOk = unsafeActionDriftOk(boundary, contract);
  const literalsOk = literalValuesOk(boundary, contract.expectedManifestShape?.requiredLiteralValues || {});
  const idempotencyOk =
    boundary.idempotency_key === runtimeModeKillSwitchPrerequisiteBoundaryIdempotencyKey(boundary);

  const staticRuleOk = {
    'baseline-pinned-833f9c1': baselineOk,
    'phase41-current': phase41Ok,
    'phase35-current-preserved': phase35Ok,
    'phase36-current-preserved': phase36Ok,
    'phase37-current-preserved': phase37Ok,
    'phase38-current-preserved': phase38Ok,
    'phase39-current-preserved': phase39Ok,
    'phase40-current-preserved': phase40Ok,
    'phase-inventory-count-41': registryOk,
    'schema-registry-count-41': registryOk,
    'cli-registry-count-41': registryOk,
    'commit-chain-exact-29': chainOk,
    'source-recommendation-tier1-selected': sourceOk,
    'phase41-tier0-satisfied-not-open': satisfiedOk,
    'phase34-prior-recommendations-satisfied': priorOk,
    'phase13-stale-preserved': phase13Ok,
    'phase23-stale-preserved': phase23Ok,
    'phase31-stale-preserved': phase31Ok,
    'closures-carried-oracle-115-123-127-131-134-137-141-148-149-156-161-165': closureOk,
    'source-refs-phase26-27-29-30-32-33-37-38-39-40-41': refsOk,
    'recent-phase-paths-present': recentPathsOk,
    'prerequisite-boundary-contract-only': prerequisiteOk,
    'runtime-mode-boundary-disabled-reference-only': modeOk,
    'kill-switch-boundary-fail-closed-reference-only': killOk,
    'prerequisite-gap-matrix-two-unsatisfied-gaps': matrixOk,
    'prerequisite-boundary-does-not-satisfy-gaps': gapsUnsatisfiedOk,
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
  };

  const acceptanceOk = {
    'baseline-833f9c1-pinned': baselineOk,
    'phase41-current-833f9c1': phase41Ok,
    'phase35-current-preserved': phase35Ok,
    'phase36-current-preserved': phase36Ok,
    'phase37-current-preserved': phase37Ok,
    'phase38-current-preserved': phase38Ok,
    'phase39-current-preserved': phase39Ok,
    'phase40-current-preserved': phase40Ok,
    'phase-inventory-exactly-41': registryOk,
    'schema-registry-exactly-41': registryOk,
    'cli-registry-exactly-41': registryOk,
    'commit-chain-count-29-ending-833f9c1': chainOk,
    'source-tier1-prerequisite-boundary-selected': sourceOk,
    'phase41-tier0-validator-satisfied': satisfiedOk,
    'phase41-tier0-validator-not-reopened': satisfiedOk,
    'phase34-prior-validator-satisfied-not-reopened': priorValidatorOk,
    'phase34-prior-cli-smoke-satisfied-not-reopened': priorCliOk,
    'phase13-stale-truth-preserved': phase13Ok,
    'phase23-stale-truth-preserved': phase23Ok,
    'phase31-stale-superseded-by-phase34': phase31Ok,
    'closures-oracle-115-123-127-131-134-137-141-148-149-156-161-165-present': closureOk,
    'source-refs-phase26-27-29-30-32-33-37-38-39-40-41-present': refsOk,
    'recent-phase-paths-present': recentPathsOk,
    'prerequisite-boundary-required-fields-present':
      hasRequiredFields(boundary.prerequisite_boundary, contract.prerequisiteBoundaryShapeExpected?.requiredFields || []),
    'prerequisite-boundary-non-authorizing': prerequisiteOk,
    'prerequisite-boundary-blocks-runtime-now': prerequisiteOk,
    'runtime-mode-boundary-required-fields-present':
      hasRequiredFields(boundary.runtime_mode_boundary, contract.runtimeModeBoundaryShapeExpected?.requiredFields || []),
    'runtime-mode-boundary-disabled-default':
      boundary.runtime_mode_boundary?.default_state === 'disabled'
      && boundary.runtime_mode_boundary?.effective_state === 'disabled',
    'runtime-mode-boundary-local-dev-only':
      boundary.runtime_mode_boundary?.local_only === true
      && boundary.runtime_mode_boundary?.dev_only === true,
    'runtime-mode-boundary-unimplemented':
      boundary.runtime_mode_boundary?.implemented_now === false
      && boundary.runtime_mode_boundary?.flag_reader_implemented === false,
    'runtime-mode-boundary-no-flag-read': boundary.runtime_mode_boundary?.flag_read_now === false,
    'runtime-mode-boundary-non-authorizing': modeOk,
    'kill-switch-boundary-required-fields-present':
      hasRequiredFields(boundary.kill_switch_boundary, contract.killSwitchBoundaryShapeExpected?.requiredFields || []),
    'kill-switch-boundary-fail-closed':
      boundary.kill_switch_boundary?.default_behavior === 'fail_closed'
      && valuesMatch(boundary.kill_switch_boundary?.fail_closed_states, ['missing', 'false', 'invalid', 'stale', 'unknown']),
    'kill-switch-boundary-unwired':
      boundary.kill_switch_boundary?.wired === false
      && boundary.kill_switch_boundary?.killWired === false,
    'kill-switch-boundary-no-live-check':
      boundary.kill_switch_boundary?.live_check_performed === false
      && boundary.kill_switch_boundary?.liveCheck === false,
    'kill-switch-boundary-non-authorizing': killOk,
    'prerequisite-gap-matrix-exactly-two': matrixOk,
    'prerequisite-gap-matrix-unsatisfied-and-blocking': matrixOk,
    'runtime-started-false': boundary.capability_matrix?.runtimeStarted === false
      && boundary.boundary_truth?.runtimeStarted === false
      && boundary.side_effect_result?.runtimeStarted === false,
    'runner-executed-false': boundary.capability_matrix?.runnerExecuted === false
      && boundary.boundary_truth?.runnerExecuted === false
      && boundary.side_effect_result?.runnerExecuted === false,
    'runtime-available-false': boundary.capability_matrix?.runtimeAvailable === false
      && boundary.boundary_truth?.runtimeAvailable === false,
    'server-can-execute-local-false': boundary.capability_matrix?.serverCanExecuteLocal === false
      && boundary.boundary_truth?.serverCanExecuteLocal === false,
    'server-can-prove-model-processing-false': boundary.capability_matrix?.serverCanProveModelProcessing === false
      && boundary.boundary_truth?.serverCanProveModelProcessing === false,
    'builder-oracle-direct-targets-blocked': boundary.capability_matrix?.directBuilderOracleServerTargetsAllowed === false
      && boundary.boundary_truth?.builderOracleDirectServerTargetsAllowed === false,
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
  add('boundary-literal-values', literalsOk);
  add('boundary-contract-complete',
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

function literalResultsOk(results = [], boundary = {}, contract = {}) {
  const expected = requiredLiteralResults(boundary, contract.expectedManifestShape?.requiredLiteralValues || {});
  return valuesMatch(asArray(results), expected)
    && results.length >= Number(contract.expectedManifestShape?.expectedCounts?.required_literal_results_min || 0);
}

function buildValidationReport(boundary, contract = {}, generatedAt = boundary.generated_at) {
  const validation = validateBoundary(boundary, contract);
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
    version: RUNTIME_MODE_KILL_SWITCH_PREREQUISITE_BOUNDARY_VERSION,
    validation_id: `runtime-mode-kill-switch-prerequisite-boundary-validation-${stableHash({
      boundary_key: boundary.idempotency_key,
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
    required_literal_results: requiredLiteralResults(boundary, contract.expectedManifestShape?.requiredLiteralValues || {}),
    referenced_path_results: buildReferencedPathResults(contract),
    forbidden_output_scan: resultObject('forbidden-output-strings-absent', forbiddenScanOk),
    side_effect_truth: sideEffectResult(),
    summary: {
      current_through_phase: boundary.phase_registry?.current_through_phase,
      phase_registry_count: boundary.phase_registry?.phase_inventory_count,
      schema_registry_count: boundary.phase_registry?.schema_registry_count,
      cli_registry_count: boundary.phase_registry?.cli_registry_count,
      commit_chain_count: asArray(boundary.commit_chain).length,
      source_ref_count: asArray(boundary.source_refs).length,
      prerequisite_gap_count: asArray(boundary.prerequisite_gap_matrix).length,
      next_recommendation_count: asArray(boundary.next_phase_recommendations).length,
      baseline_commit: boundary.baseline_commit,
      accepted_validation_only: validation.ok,
    },
  };
  assertNoForbiddenOutput(report, asArray(contract.forbiddenOutputSubstrings));
  return report;
}

function buildMiraCoreRuntimeModeKillSwitchPrerequisiteBoundary(options = {}) {
  const contract = options.contract || {};
  const runtime_mode_kill_switch_prerequisite_boundary = buildBoundary(options);
  const validation_report = buildValidationReport(
    runtime_mode_kill_switch_prerequisite_boundary,
    contract,
    runtime_mode_kill_switch_prerequisite_boundary.generated_at,
  );
  const output = {
    runtime_mode_kill_switch_prerequisite_boundary,
    validation_report,
  };
  assertNoForbiddenOutput(output, asArray(contract.forbiddenOutputSubstrings));
  return output;
}

function validateMiraCoreRuntimeModeKillSwitchPrerequisiteBoundaryOutput(output = {}, contract = {}) {
  const checks = [];
  const errors = [];
  const add = (id, ok) => {
    checks.push({ id, ok: ok === true });
    if (!ok) errors.push(id);
  };
  const boundary = output.runtime_mode_kill_switch_prerequisite_boundary || {};
  const report = output.validation_report || {};
  const boundaryValidation = validateBoundary(boundary, contract);
  const referencedOk = referencedPathResultsOk(report.referenced_path_results, contract);
  const recomputedById = boundaryValidation.checks.reduce((acc, check) => {
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
    && literalResultsOk(report.required_literal_results, boundary, contract)
    && referencedOk;

  add('output-shape-complete',
    hasRequiredFields(output, contract.expectedOutputShape?.requiredTopLevelFields || REQUIRED_OUTPUT_FIELDS)
      && boundary.schema === RUNTIME_MODE_KILL_SWITCH_PREREQUISITE_BOUNDARY_SCHEMA_VERSION
      && report.schema === VALIDATION_REPORT_SCHEMA_VERSION
      && hasRequiredFields(boundary, contract.expectedManifestShape?.requiredFields || REQUIRED_BOUNDARY_FIELDS)
      && hasRequiredFields(report, contract.expectedValidationReportShape?.requiredFields || REQUIRED_VALIDATION_REPORT_FIELDS));

  for (const check of boundaryValidation.checks) {
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
    report.accepted === boundaryValidation.ok
      && report.blocked === !boundaryValidation.ok
      && report.decision === (boundaryValidation.ok ? 'accepted_validation_only' : 'rejected')
      && valuesMatch(
        asArray(report.reasons),
        boundaryValidation.checks.filter((check) => !check.ok).map((check) => check.id),
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
  REQUIRED_BOUNDARY_FIELDS,
  REQUIRED_OUTPUT_FIELDS,
  REQUIRED_SIDE_EFFECT_FIELDS,
  REQUIRED_VALIDATION_REPORT_FIELDS,
  RUNTIME_MODE_KILL_SWITCH_PREREQUISITE_BOUNDARY_SCHEMA_VERSION,
  VALIDATION_REPORT_SCHEMA_VERSION,
  assertNoForbiddenOutput,
  buildMiraCoreRuntimeModeKillSwitchPrerequisiteBoundary,
  runtimeModeKillSwitchPrerequisiteBoundaryIdempotencyKey,
  stableHash,
  validateMiraCoreRuntimeModeKillSwitchPrerequisiteBoundaryOutput,
};
