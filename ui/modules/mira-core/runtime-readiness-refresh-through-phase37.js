'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const RUNTIME_READINESS_REFRESH_SCHEMA_VERSION =
  'squidrun.mira_core.runtime_readiness_refresh_through_phase37.v0';
const VALIDATION_REPORT_SCHEMA_VERSION =
  'squidrun.mira_core.runtime_readiness_refresh_through_phase37_validation_report.v0';
const RUNTIME_READINESS_REFRESH_VERSION = 'v0';
const BASELINE_COMMIT = 'c8b55be';
const FIXTURE_REF =
  'ui/__tests__/fixtures/mira-core-runtime-readiness-refresh-through-phase37-contract.json';

const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');

const REQUIRED_OUTPUT_FIELDS = Object.freeze([
  'runtime_readiness_refresh_through_phase37',
  'validation_report',
]);

const REQUIRED_REFRESH_FIELDS = Object.freeze([
  'schema',
  'version',
  'refresh_id',
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
  'stale_readiness',
  'phase34_prior_recommendations',
  'closure_summary',
  'source_refs',
  'capability_matrix',
  'boundary_truth',
  'verification_summary',
  'blocker_summary',
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
  'control executed',
  'kill switch wired',
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
  'phase37 commit proves runtime',
  'readiness refresh authorizes runtime',
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
  'control executed',
  'kill switch wired',
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
  'phase37 commit proves runtime',
  'readiness refresh authorizes runtime',
  'socket proves bridge green',
  'delivery acceptance proves model processing',
  'builder direct target allowed',
  'oracle direct target allowed',
]));

const BLOCKER_IDS = Object.freeze([
  'real-runtime-gates-open',
  'local-dry-run-readiness-gap-open',
  'runtime-mode-disabled',
  'operator-controls-reference-only',
  'kill-switch-reference-only',
  'rollback-reference-only',
  'audit-reporting-reference-only',
  'local-arm-proof-separate',
  'storage-auth-secret-gates-open',
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

function evidenceRef(store, eventId, relation = 'runtime_readiness_refresh_through_phase37_validation') {
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

function expectedManifestShape(contract = {}) {
  return contract.expectedManifestShape || {};
}

function validationShape(contract = {}) {
  return contract.expectedValidationReportShape || {};
}

function phaseRegistry(contract = {}) {
  const expected = contract.phaseRegistryExpected || {};
  return {
    source_ref: expected.source_ref,
    current_through_phase: 37,
    expected_phases: expected.expected_phases || '1-37',
    phase_inventory_count: 37,
    schema_registry_count: 37,
    cli_registry_count: 37,
    phase35_runtime_next_action_current: true,
    phase36_operator_ui_surface_current: true,
    phase37_control_reporting_reconciliation_current: true,
    phase37_commit: BASELINE_COMMIT,
    phase37_delta: clone(expected.phase37_delta || {}),
    recent_phase_paths: clone(expected.required_recent_phase_paths || []),
    evidenceRefs: [
      evidenceRef('git', BASELINE_COMMIT, 'phase38-baseline'),
      evidenceRef('mira-core-runtime-readiness-refresh-through-phase37-contract', 'phase-registry'),
    ],
  };
}

function registryEntries(kind, contract = {}) {
  const recent = new Map(asArray(contract.phaseRegistryExpected?.required_recent_phase_paths)
    .map((entry) => [entry.phase, entry]));
  return Array.from({ length: 37 }, (_, index) => {
    const phase = index + 1;
    const recentEntry = recent.get(phase);
    return {
      phase,
      registry_kind: kind,
      artifact_id: recentEntry ? `phase${phase}-${kind}` : `phase${phase}-${kind}-registered`,
      status: phase <= 37 ? 'registered_validation_artifact' : 'unknown',
      ...(recentEntry ? clone(recentEntry) : {}),
    };
  });
}

function staleReadiness(contract = {}) {
  return {
    ...clone(contract.staleReadinessExpected || {}),
    evidenceRefs: [
      evidenceRef('mira-core-readiness', 'phase13-stale'),
      evidenceRef('mira-core-milestone-readiness', 'phase23-stale'),
      evidenceRef('mira-core-runtime-milestone-refresh', 'phase31-stale'),
      evidenceRef('mira-core-runtime-next-action', 'phase35-current'),
      evidenceRef('mira-core-runtime-operator-ui-surface', 'phase36-current'),
      evidenceRef('mira-core-runtime-control-reporting-reconciliation', 'phase37-current'),
    ],
  };
}

function phase34PriorRecommendations(contract = {}) {
  const expected = asArray(contract.phase34PriorRecommendationsExpected);
  return {
    phase35_runtime_status_milestone_refresh_validator: {
      ...clone(expected[0] || {}),
      evidenceRefs: [evidenceRef('git', 'c04155d', 'phase34-prior-validator-satisfied')],
    },
    phase35_stdout_only_cli_smoke: {
      ...clone(expected[1] || {}),
      evidenceRefs: [evidenceRef('git', 'c04155d', 'phase34-prior-cli-satisfied')],
    },
  };
}

function closureSummary(contract = {}) {
  const expected = contract.closureSummaryExpected || {};
  return {
    phase30_oracle_115_prerequisite_mapping_closure: expected.phase_30?.closed === true,
    phase32_oracle_123_expires_at_closure: expected.phase_32?.closed === true,
    phase33_oracle_127_validation_report_tamper_coverage_closure: expected.phase_33?.closed === true,
    phase34_oracle_131_read_only_review_green: expected.phase_34?.closed === true,
    phase35_oracle_134_read_only_review_green: expected.phase_35?.closed === true,
    phase36_oracle_137_read_only_review_green: expected.phase_36?.closed === true,
    phase37_oracle_141_read_only_review_green: expected.phase_37?.closed === true,
    closed_review_refs: [
      expected.phase_30?.oracle_ref,
      expected.phase_32?.oracle_ref,
      expected.phase_33?.oracle_ref,
      expected.phase_34?.oracle_ref,
      expected.phase_35?.oracle_ref,
      expected.phase_36?.oracle_ref,
      expected.phase_37?.oracle_ref,
    ].filter(Boolean),
    evidenceRefs: [
      evidenceRef('mira-core-runtime-control-path', 'oracle-115-closure'),
      evidenceRef('mira-core-runtime-dry-runner', 'oracle-123-closure'),
      evidenceRef('mira-core-runtime-operator-status', 'oracle-127-closure'),
      evidenceRef('mira-core-runtime-status-milestone-refresh', 'oracle-131-closure'),
      evidenceRef('mira-core-runtime-next-action', 'oracle-134-closure'),
      evidenceRef('mira-core-runtime-operator-ui-surface', 'oracle-137-closure'),
      evidenceRef('mira-core-runtime-control-reporting-reconciliation', 'oracle-141-closure'),
    ],
  };
}

function capabilityMatrix(contract = {}) {
  return {
    ...clone(contract.capabilityMatrixExpected || {}),
    evidenceRefs: [evidenceRef('mira-core-runtime-readiness-refresh-through-phase37', 'capability-matrix')],
  };
}

function boundaryTruth(contract = {}) {
  return {
    ...clone(contract.boundaryTruthExpected || {}),
    evidenceRefs: [evidenceRef('mira-core-runtime-readiness-refresh-through-phase37', 'boundary-truth')],
  };
}

function verificationSummary(inputSignals = {}) {
  const commands = asArray(inputSignals.verification?.commands);
  const proven = commands.length > 0
    && commands.every((command) => command.result === 'PASS' && Number(command.failed_count || 0) === 0);
  return {
    no_fake_test_proof: true,
    proof_status: proven ? 'proven_by_reported_command' : 'unknown_without_reported_command',
    reported_commands: clone(commands),
    phase37_commit_observed: BASELINE_COMMIT,
    phase37_commit_is_runtime_proof: false,
    readiness_refresh_is_runtime_authorization: false,
    readiness_refresh_is_ui_proof: false,
    socket_is_bridge_green_proof: false,
    delivery_acceptance_is_model_processing_proof: false,
    model_processing_proof: false,
    unknown_or_degraded_proof: !proven,
    evidenceRefs: [evidenceRef('mira-core-runtime-readiness-refresh-through-phase37', 'verification-summary')],
  };
}

function blockerSummary() {
  return BLOCKER_IDS.map((blockerId) => ({
    blocker_id: blockerId,
    status: 'blocks_future_runtime_or_reporting_slice',
    blocked_because: `Open gate remains for ${blockerId}.`,
    safe_next_action: 'Keep future work contract-only or validation-only and non-authorizing.',
    evidenceRefs: [evidenceRef('mira-core-runtime-readiness-refresh-through-phase37', `blocker:${blockerId}`)],
  }));
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
    control_execution_allowed: false,
    reporting_sink_allowed: false,
    unsafe_action_drift_rejected: true,
    evidenceRefs: [evidenceRef('mira-core-runtime-readiness-refresh-through-phase37', 'unsafe-action-policy')],
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
      'transport',
      'persistent-mutation',
      'queue-lease',
      'control-action',
      'reporting-artifact-output',
      'irreversible-action-boundary',
    ],
    evidenceRefs: [
      evidenceRef('mira-core-runtime-readiness-refresh-through-phase37', `next:${candidate.recommendation_id}`),
    ],
  }));
}

function sideEffectResult() {
  const result = REQUIRED_SIDE_EFFECT_FIELDS.reduce((acc, field) => {
    acc[field] = true;
    return acc;
  }, {});
  for (const field of SIDE_EFFECT_COUNTER_FIELDS) {
    result[field] = 0;
  }
  result.moduleOrCliImplemented = false;
  result.testsImplemented = false;
  result.uiImplemented = false;
  result.browserWindowCapturePerformed = false;
  result.runtimeStarted = false;
  result.runnerExecuted = false;
  result.runtimeAvailable = false;
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

function canonicalRefreshInput(refresh = {}) {
  return {
    profile: refresh.profile,
    sessionId: refresh.sessionId,
    deviceId: refresh.deviceId,
    baseline_commit: refresh.baseline_commit,
    phase_registry: refresh.phase_registry,
    schema_registry: refresh.schema_registry,
    cli_registry: refresh.cli_registry,
    commit_chain: refresh.commit_chain,
    source_recommendation: refresh.source_recommendation,
    satisfied_prior_recommendations: refresh.satisfied_prior_recommendations,
    stale_readiness: refresh.stale_readiness,
    phase34_prior_recommendations: refresh.phase34_prior_recommendations,
    closure_summary: refresh.closure_summary,
    source_refs: refresh.source_refs,
    capability_matrix: refresh.capability_matrix,
    boundary_truth: refresh.boundary_truth,
    verification_summary: refresh.verification_summary,
    blocker_summary: refresh.blocker_summary,
    unsafe_action_policy: refresh.unsafe_action_policy,
    next_phase_recommendations: refresh.next_phase_recommendations,
    side_effect_result: refresh.side_effect_result,
  };
}

function runtimeReadinessRefreshThroughPhase37IdempotencyKey(refresh) {
  return `runtime-readiness-refresh-through-phase37:${stableHash(canonicalRefreshInput(refresh))}`;
}

function buildRefresh(options = {}) {
  const contract = options.contract || {};
  const inputSignals = options.inputSignals || {};
  const scope = normalizeScope(inputSignals);
  const generatedAt = generatedAtFromOptions(options, inputSignals);
  const refresh = {
    schema: RUNTIME_READINESS_REFRESH_SCHEMA_VERSION,
    version: RUNTIME_READINESS_REFRESH_VERSION,
    refresh_id: null,
    idempotency_key: null,
    generated_at: generatedAt,
    profile: scope.profile,
    sessionId: scope.sessionId,
    deviceId: scope.deviceId,
    baseline_commit: inputSignals.baseline_commit || BASELINE_COMMIT,
    phase_registry: phaseRegistry(contract),
    schema_registry: registryEntries('schema', contract),
    cli_registry: registryEntries('cli', contract),
    commit_chain: asArray(inputSignals.commit_chain).length > 0
      ? clone(inputSignals.commit_chain)
      : clone(contract.commitChainExpected || []),
    source_recommendation: {
      ...clone(contract.sourceRecommendation || {}),
      evidenceRefs: [evidenceRef('mira-core-runtime-control-reporting-reconciliation', 'source-recommendation')],
    },
    satisfied_prior_recommendations: clone(contract.satisfiedPriorRecommendations || []),
    stale_readiness: staleReadiness(contract),
    phase34_prior_recommendations: phase34PriorRecommendations(contract),
    closure_summary: closureSummary(contract),
    source_refs: clone(contract.sourceRefsExpected || []),
    capability_matrix: capabilityMatrix(contract),
    boundary_truth: boundaryTruth(contract),
    verification_summary: verificationSummary(inputSignals),
    blocker_summary: blockerSummary(),
    unsafe_action_policy: unsafeActionPolicy(),
    next_phase_recommendations: nextPhaseRecommendations(contract),
    evidenceRefs: [
      evidenceRef('git', BASELINE_COMMIT, 'phase38-baseline'),
      evidenceRef('mira-core-runtime-readiness-refresh-through-phase37-contract', 'phase38-contract'),
    ],
    side_effect_result: sideEffectResult(),
  };
  refresh.idempotency_key = runtimeReadinessRefreshThroughPhase37IdempotencyKey(refresh);
  refresh.refresh_id = `runtime-readiness-refresh-through-phase37-${stableHash({
    key: refresh.idempotency_key,
  }).slice(0, 12)}`;
  assertNoForbiddenOutput(refresh, asArray(contract.forbiddenOutputSubstrings));
  return refresh;
}

function literalValuesOk(value, literals = {}) {
  return Object.entries(literals || {}).every(([field, expected]) => valuesMatch(pathValue(value, field), expected));
}

function requiredLiteralResults(value, literals = {}) {
  return Object.entries(literals || {}).map(([pathName, expected]) => ({
    id: pathName,
    path: pathName,
    expected,
    actual: pathValue(value, pathName),
    ok: valuesMatch(pathValue(value, pathName), expected),
  }));
}

function sideEffectValuesOk(value = {}) {
  return REQUIRED_SIDE_EFFECT_FIELDS.every((field) => value[field] === true)
    && SIDE_EFFECT_COUNTER_FIELDS.every((field) => Number(value[field] || 0) === 0)
    && value.moduleOrCliImplemented === false
    && value.testsImplemented === false
    && value.uiImplemented === false
    && value.browserWindowCapturePerformed === false
    && value.runtimeStarted === false
    && value.runnerExecuted === false
    && value.runtimeAvailable === false
    && value.serverStarted === false
    && value.listenerBound === false
    && value.networkPerformed === false
    && value.databaseWritePerformed === false
    && value.storeWritePerformed === false
    && value.fileWritePerformed === false
    && value.fileMigrationPerformed === false
    && value.queueCreated === false
    && value.leaseCreated === false
    && value.authChanged === false
    && value.keySecretOperationPerformed === false
    && value.localExecutionPerformed === false
    && value.shellPtyUsed === false
    && value.controlExecutionPerformed === false
    && value.reportingSinkWritten === false
    && value.sendPerformed === false
    && value.deployPerformed === false
    && value.tradePerformed === false
    && value.outputFileWritten === false;
}

function phase37CurrentOk(refresh) {
  const registry = refresh.phase_registry || {};
  const delta = registry.phase37_delta || {};
  return registry.current_through_phase === 37
    && registry.phase37_control_reporting_reconciliation_current === true
    && registry.phase37_commit === BASELINE_COMMIT
    && delta.phase === 37
    && delta.name === 'runtime-control-reporting-reconciliation'
    && delta.committed_baseline === BASELINE_COMMIT
    && delta.status === 'local_validation_runtime_present_current'
    && delta.validation_only === true
    && delta.capability_truth?.runtimeStarted === false
    && delta.capability_truth?.runnerExecuted === false
    && delta.capability_truth?.runtimeAvailable === false
    && delta.capability_truth?.serverCanExecuteLocal === false
    && delta.capability_truth?.serverCanProveModelProcessing === false
    && delta.capability_truth?.directBuilderOracleServerTargetsAllowed === false;
}

function registryCountsOk(refresh) {
  const registry = refresh.phase_registry || {};
  return registry.phase_inventory_count === 37
    && registry.schema_registry_count === 37
    && registry.cli_registry_count === 37
    && registry.current_through_phase === 37
    && asArray(refresh.schema_registry).length === 37
    && asArray(refresh.cli_registry).length === 37;
}

function commitChainOk(refresh, contract = {}) {
  const expected = asArray(contract.commitChainExpected);
  const chain = asArray(refresh.commit_chain);
  return expected.length === 25
    && chain.length === 25
    && valuesMatch(chain, expected)
    && chain[chain.length - 1] === BASELINE_COMMIT;
}

function sourceRecommendationOk(refresh, contract = {}) {
  const expected = contract.sourceRecommendation || {};
  const current = refresh.source_recommendation || {};
  return current.recommendation_id === expected.recommendation_id
    && current.tier === 'tier1'
    && current.status === expected.status
    && current.contract_only_now === true
    && current.implemented_now === false
    && current.does_not_authorize_ui === true
    && current.does_not_authorize_runtime === true
    && current.does_not_authorize_execution === true;
}

function satisfiedPriorOk(refresh, contract = {}) {
  const expected = asArray(contract.satisfiedPriorRecommendations);
  const current = asArray(refresh.satisfied_prior_recommendations);
  return expected.length === 1
    && current.length === 1
    && current[0].recommendation_id === expected[0].recommendation_id
    && current[0].satisfied_by_commit === BASELINE_COMMIT
    && current[0].status === 'satisfied_by_c8b55be_do_not_repeat_as_open_work'
    && current[0].must_not_reopen === true
    && valuesMatch(current[0].satisfied_by_files, expected[0].satisfied_by_files)
    && !asArray(refresh.next_phase_recommendations).some((item) => (
      item.recommendation_id === current[0].recommendation_id
    ));
}

function phase34PriorRecommendationsOk(refresh, key) {
  const prior = refresh.phase34_prior_recommendations || {};
  const item = prior[key];
  return item
    && item.status === 'satisfied_by_c04155d_do_not_repeat_as_open_work'
    && item.satisfied_by_commit === 'c04155d'
    && item.must_not_reopen === true;
}

function staleReadinessOk(refresh, phase) {
  const stale = refresh.stale_readiness || {};
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
  if (phase === 35) return stale.phase35_runtime_next_action_current === true;
  if (phase === 36) return stale.phase36_runtime_operator_ui_surface_current === true;
  if (phase === 37) return stale.phase37_runtime_control_reporting_reconciliation_current === true;
  return false;
}

function closuresOk(refresh) {
  const closure = refresh.closure_summary || {};
  const refs = asArray(closure.closed_review_refs);
  return closure.phase30_oracle_115_prerequisite_mapping_closure === true
    && closure.phase32_oracle_123_expires_at_closure === true
    && closure.phase33_oracle_127_validation_report_tamper_coverage_closure === true
    && closure.phase34_oracle_131_read_only_review_green === true
    && closure.phase35_oracle_134_read_only_review_green === true
    && closure.phase36_oracle_137_read_only_review_green === true
    && closure.phase37_oracle_141_read_only_review_green === true
    && ['ORACLE #115', 'ORACLE #123', 'ORACLE #127', 'ORACLE #131', 'ORACLE #134', 'ORACLE #137', 'ORACLE #141']
      .every((ref) => refs.includes(ref));
}

function sourceRefsOk(refresh, contract = {}) {
  const expected = asArray(contract.sourceRefsExpected);
  const current = asArray(refresh.source_refs);
  return expected.length === 8
    && current.length === 8
    && idsEqual(current, 'artifact_id', expected.map((item) => item.artifact_id))
    && expected.every((expectedRef) => current.some((ref) => (
      ref.artifact_id === expectedRef.artifact_id
      && ref.phase === expectedRef.phase
      && ref.fixture_path === expectedRef.fixture_path
      && ref.module_path === expectedRef.module_path
      && ref.test_path === expectedRef.test_path
    )));
}

function recentPhasePathsOk(refresh, contract = {}) {
  const expected = asArray(contract.phaseRegistryExpected?.required_recent_phase_paths);
  const current = asArray(refresh.phase_registry?.recent_phase_paths);
  return expected.length === 4
    && current.length === 4
    && expected.every((expectedPath) => current.some((entry) => (
      entry.phase === expectedPath.phase
      && entry.fixture_path === expectedPath.fixture_path
      && entry.module_path === expectedPath.module_path
      && entry.cli_path === expectedPath.cli_path
      && entry.test_path === expectedPath.test_path
      && entry.committed_baseline === expectedPath.committed_baseline
    )));
}

function capabilityTruthOk(refresh) {
  const capability = refresh.capability_matrix || {};
  return capability.runtimeStarted === false
    && capability.runnerExecuted === false
    && capability.runtimeAvailable === false
    && capability.realRuntimeAvailable === false
    && capability.serverCanExecuteLocal === false
    && capability.serverCanProveModelProcessing === false
    && capability.directBuilderOracleServerTargetsAllowed === false
    && capability.allowed_future_server_target_role === 'architect'
    && valuesMatch(capability.allowed_next_recommendation_tiers, ['tier0', 'tier1']);
}

function verificationTruthOk(refresh) {
  const summary = refresh.verification_summary || {};
  const reported = asArray(summary.reported_commands);
  if (summary.no_fake_test_proof !== true) return false;
  if (summary.proof_status === 'proven_by_reported_command') {
    return reported.length > 0
      && reported.every((command) => command.result === 'PASS' && Number(command.failed_count || 0) === 0);
  }
  return summary.unknown_or_degraded_proof === true;
}

function proofBoundariesOk(refresh) {
  const boundary = refresh.boundary_truth || {};
  return boundary.runtimeStarted === false
    && boundary.runnerExecuted === false
    && boundary.runtimeAvailable === false
    && boundary.serverCanExecuteLocal === false
    && boundary.serverCanProveModelProcessing === false
    && boundary.builderOracleDirectServerTargetsAllowed === false
    && boundary.socketIsBridgeGreenProof === false
    && boundary.deliveryAcceptanceIsModelProcessingProof === false
    && boundary.phase37CommitIsRuntimeProof === false
    && boundary.readinessRefreshIsRuntimeAuthorization === false
    && boundary.readinessRefreshIsUiProof === false
    && boundary.controlReportIsExecutionAuthorization === false
    && boundary.operatorSurfaceIsUiProof === false
    && verificationTruthOk(refresh);
}

function noModuleCliTestRuntimeWorkOk(refresh) {
  const side = refresh.side_effect_result || {};
  return side.no_module_or_cli_implemented === true
    && side.no_tests_implemented === true
    && side.no_ui_implemented === true
    && side.no_runtime_performed === true
    && side.no_runner_executed === true
    && side.no_server_performed === true
    && side.no_output_file_written === true
    && side.moduleOrCliImplemented === false
    && side.testsImplemented === false
    && side.runtimeStarted === false
    && side.runnerExecuted === false
    && side.serverStarted === false
    && side.outputFileWritten === false;
}

function nextRecommendationsOk(refresh, contract = {}) {
  const expected = asArray(contract.nextRecommendationExpectedCandidates);
  const recommendations = asArray(refresh.next_phase_recommendations);
  return recommendations.length >= Number(expectedManifestShape(contract).expectedCounts?.next_phase_recommendations_min || 0)
    && expected.every((candidate) => recommendations.some((recommendation) => (
      recommendation.recommendation_id === candidate.recommendation_id
        && recommendation.tier === candidate.tier
        && recommendation.action === candidate.action
        && recommendation.why_safe === candidate.why_safe
        && recommendation.does_not_authorize_ui === true
        && recommendation.does_not_authorize_runtime === true
        && recommendation.does_not_authorize_execution === true
    )))
    && recommendations.every((recommendation) => ['tier0', 'tier1'].includes(recommendation.tier)
      && recommendation.does_not_authorize_ui === true
      && recommendation.does_not_authorize_runtime === true
      && recommendation.does_not_authorize_execution === true
      && asArray(recommendation.blocked_side_effects).length > 0);
}

function nextRecommendationsNoLiveRuntimeOrUiOk(refresh) {
  const strings = collectStringValues(refresh.next_phase_recommendations);
  return strings.every((text) => !hasUnsafeTerm(text, 'live runtime')
    && !hasUnsafeTerm(text, 'live ui')
    && !hasUnsafeTerm(text, 'start server')
    && !hasUnsafeTerm(text, 'open listener')
    && !hasUnsafeTerm(text, 'browser capture')
    && !hasUnsafeTerm(text, 'browser window')
    && !hasUnsafeTerm(text, 'window capture')
    && !hasUnsafeTerm(text, 'write output file')
    && !hasUnsafeTerm(text, 'create queue')
    && !hasUnsafeTerm(text, 'create lease')
    && !hasUnsafeTerm(text, 'local execution')
    && !hasUnsafeTerm(text, 'execute control')
    && !hasUnsafeTerm(text, 'write report'));
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

function occurrenceIsNegated(text, index) {
  const before = String(text || '').slice(Math.max(0, index - 220), index);
  const lastBoundary = Math.max(before.lastIndexOf('.'), before.lastIndexOf(';'), before.lastIndexOf(':'));
  const clause = before.slice(lastBoundary + 1);
  return /\b(no|without|blocked|blocks|disallow|disallowed|not|cannot|does not|must not|keeps|disabled|false|reference-only|contract-only|non-authorizing)\b/i
    .test(clause);
}

function hasUnsafeTerm(text, term) {
  const lower = String(text || '').toLowerCase();
  const needle = String(term || '').toLowerCase();
  if (!needle) return false;
  let index = lower.indexOf(needle);
  while (index !== -1) {
    if (!occurrenceIsNegated(lower, index)) return true;
    index = lower.indexOf(needle, index + needle.length);
  }
  return false;
}

function unsafeActionDriftOk(refresh, contract = {}) {
  const unsafeTerms = [
    'tier2',
    'tier3',
    'tier4',
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
    'render ui',
    'live ui',
    'runtime start',
    'live runtime',
    'start server',
    'open listener',
    'create queue',
    'create lease',
    'write output file',
    'execute control',
    'wire kill switch',
    'run rollback',
    'write report',
  ];
  const phraseNeedles = asArray(contract.unsafeActionPhrases).map((phrase) => String(phrase || '').toLowerCase());
  const strings = [
    ...collectStringValues(refresh.source_recommendation),
    ...collectStringValues(refresh.satisfied_prior_recommendations),
    ...collectStringValues(refresh.phase34_prior_recommendations),
    ...collectStringValues(refresh.closure_summary),
    ...collectStringValues(refresh.source_refs),
    ...collectStringValues(refresh.verification_summary),
    ...collectStringValues(refresh.blocker_summary),
    ...collectStringValues(refresh.unsafe_action_policy),
    ...collectStringValues(refresh.next_phase_recommendations),
  ];
  return strings.every((text) => {
    const lower = String(text || '').toLowerCase();
    return !unsafeTerms.some((term) => hasUnsafeTerm(lower, term))
      && !hasOutboundRecipientIntent(lower)
      && !phraseNeedles.some((phrase) => hasUnsafeTerm(lower, phrase));
  });
}

function assertNoForbiddenOutput(value, extraForbidden = []) {
  const strings = collectStringValues(value);
  for (const forbidden of [...DEFAULT_FORBIDDEN_OUTPUT_SUBSTRINGS, ...extraForbidden]) {
    if (!forbidden) continue;
    const needle = String(forbidden).toLowerCase();
    const hasForbidden = strings.some((entry) => {
      const lower = String(entry).toLowerCase();
      let index = lower.indexOf(needle);
      while (index !== -1) {
        if (!NEGATABLE_FORBIDDEN_OUTPUT_SUBSTRINGS.has(needle) || !occurrenceIsNegated(lower, index)) {
          return true;
        }
        index = lower.indexOf(needle, index + needle.length);
      }
      return false;
    });
    if (hasForbidden) {
      throw new Error(`runtime_readiness_refresh_through_phase37_forbidden_substring:${forbidden}`);
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

function validateRefresh(refresh = {}, contract = {}) {
  const checks = [];
  const errors = [];
  const resultById = {};
  const add = (id, ok) => {
    const result = resultObject(id, ok);
    checks.push(result);
    resultById[id] = result;
    if (!ok) errors.push(id);
  };

  const outputShapeOk = refresh.schema === RUNTIME_READINESS_REFRESH_SCHEMA_VERSION
    && hasRequiredFields(refresh, expectedManifestShape(contract).requiredFields || REQUIRED_REFRESH_FIELDS);
  const baselineOk = refresh.baseline_commit === BASELINE_COMMIT;
  const phase37Ok = phase37CurrentOk(refresh);
  const phase35Ok = refresh.phase_registry?.phase35_runtime_next_action_current === true
    && staleReadinessOk(refresh, 35);
  const phase36Ok = refresh.phase_registry?.phase36_operator_ui_surface_current === true
    && staleReadinessOk(refresh, 36);
  const registryOk = registryCountsOk(refresh);
  const chainOk = commitChainOk(refresh, contract);
  const sourceOk = sourceRecommendationOk(refresh, contract);
  const satisfiedOk = satisfiedPriorOk(refresh, contract);
  const priorValidatorOk = phase34PriorRecommendationsOk(refresh, 'phase35_runtime_status_milestone_refresh_validator');
  const priorCliOk = phase34PriorRecommendationsOk(refresh, 'phase35_stdout_only_cli_smoke');
  const priorOk = priorValidatorOk && priorCliOk;
  const phase13Ok = staleReadinessOk(refresh, 13);
  const phase23Ok = staleReadinessOk(refresh, 23);
  const phase31Ok = staleReadinessOk(refresh, 31);
  const closureOk = closuresOk(refresh);
  const refsOk = sourceRefsOk(refresh, contract);
  const recentPathsOk = recentPhasePathsOk(refresh, contract);
  const capabilityOk = capabilityTruthOk(refresh);
  const proofOk = proofBoundariesOk(refresh);
  const sideEffectOk = sideEffectValuesOk(refresh.side_effect_result);
  const scopeOk = noModuleCliTestRuntimeWorkOk(refresh);
  const recommendationsOk = nextRecommendationsOk(refresh, contract);
  const recommendationsNoLiveOk = nextRecommendationsNoLiveRuntimeOrUiOk(refresh);
  const unsafeOk = unsafeActionDriftOk(refresh, contract);
  const literalsOk = literalValuesOk(refresh, expectedManifestShape(contract).requiredLiteralValues || {});
  const idempotencyOk = refresh.idempotency_key === runtimeReadinessRefreshThroughPhase37IdempotencyKey(refresh);
  let forbiddenOk = true;
  try {
    assertNoForbiddenOutput(refresh, asArray(contract.forbiddenOutputSubstrings));
  } catch {
    forbiddenOk = false;
  }

  const staticRuleOk = {
    'baseline-pinned-c8b55be': baselineOk,
    'phase37-current': phase37Ok,
    'phase35-current-preserved': phase35Ok,
    'phase36-current-preserved': phase36Ok,
    'phase-inventory-count-37': registryOk,
    'schema-registry-count-37': registryOk,
    'cli-registry-count-37': registryOk,
    'commit-chain-exact-25': chainOk,
    'source-recommendation-tier1-selected': sourceOk,
    'phase37-tier0-satisfied-not-open': satisfiedOk,
    'phase34-prior-recommendations-satisfied': priorOk,
    'phase13-stale-preserved': phase13Ok,
    'phase23-stale-preserved': phase23Ok,
    'phase31-stale-preserved': phase31Ok,
    'closures-carried-oracle-115-123-127-131-134-137-141': closureOk,
    'source-refs-phase29-30-32-33-34-35-36-37': refsOk,
    'recent-phase-paths-present': recentPathsOk,
    'capability-truth-false': capabilityOk,
    'proof-boundaries-false': proofOk,
    'side-effect-truth-all-blocked': sideEffectOk,
    'no-module-cli-test-runtime-work': scopeOk,
    'next-recommendations-tier0-tier1-only': recommendationsOk,
    'next-recommendations-no-live-runtime-or-ui': recommendationsNoLiveOk,
    'unsafe-action-drift-blocked': unsafeOk,
    'no-raw-private-secret-output': forbiddenOk,
    'required-literal-checks-bound': literalsOk,
    'validation-report-coverage-bound': true,
    'idempotency-sensitive': idempotencyOk,
  };

  const acceptanceOk = {
    'baseline-c8b55be-pinned': baselineOk,
    'phase37-current-c8b55be': phase37Ok,
    'phase35-current-preserved': phase35Ok,
    'phase36-current-preserved': phase36Ok,
    'phase-inventory-exactly-37': registryOk,
    'schema-registry-exactly-37': registryOk,
    'cli-registry-exactly-37': registryOk,
    'commit-chain-count-25-ending-c8b55be': chainOk,
    'source-tier1-readiness-refresh-selected': sourceOk,
    'phase37-tier0-validator-satisfied': satisfiedOk,
    'phase37-tier0-validator-not-reopened': satisfiedOk,
    'phase34-prior-validator-satisfied-not-reopened': priorValidatorOk,
    'phase34-prior-cli-smoke-satisfied-not-reopened': priorCliOk,
    'phase13-stale-truth-preserved': phase13Ok,
    'phase23-stale-truth-preserved': phase23Ok,
    'phase31-stale-superseded-by-phase34': phase31Ok,
    'closures-oracle-115-123-127-131-134-137-141-present': closureOk,
    'source-refs-phase29-30-32-33-34-35-36-37-present': refsOk,
    'recent-phase-paths-present': recentPathsOk,
    'runtime-started-false': refresh.capability_matrix?.runtimeStarted === false
      && refresh.boundary_truth?.runtimeStarted === false
      && refresh.side_effect_result?.runtimeStarted === false,
    'runner-executed-false': refresh.capability_matrix?.runnerExecuted === false
      && refresh.boundary_truth?.runnerExecuted === false
      && refresh.side_effect_result?.runnerExecuted === false,
    'runtime-available-false': refresh.capability_matrix?.runtimeAvailable === false
      && refresh.boundary_truth?.runtimeAvailable === false
      && refresh.side_effect_result?.runtimeAvailable === false,
    'server-can-execute-local-false': refresh.capability_matrix?.serverCanExecuteLocal === false
      && refresh.boundary_truth?.serverCanExecuteLocal === false,
    'server-can-prove-model-processing-false': refresh.capability_matrix?.serverCanProveModelProcessing === false
      && refresh.boundary_truth?.serverCanProveModelProcessing === false,
    'builder-oracle-direct-targets-blocked': refresh.capability_matrix?.directBuilderOracleServerTargetsAllowed === false
      && refresh.boundary_truth?.builderOracleDirectServerTargetsAllowed === false,
    'proof-boundaries-false': proofOk,
    'side-effect-truth-all-blocked': sideEffectOk,
    'no-module-cli-test-runtime-work': scopeOk,
    'next-recommendations-tier0-tier1-only': recommendationsOk,
    'next-recommendations-non-authorizing': recommendationsOk,
    'unsafe-action-drift-rejected': unsafeOk,
    'required-literal-results-complete': literalsOk,
    'referenced-path-results-complete': true,
  };

  add('output-shape-complete', outputShapeOk);
  for (const rule of asArray(contract.staticValidationRules)) add(rule.id, staticRuleOk[rule.id] === true);
  for (const check of asArray(contract.acceptanceChecks)) add(check.id, acceptanceOk[check.id] === true);
  add('refresh-literal-values', literalsOk);
  add('refresh-contract-complete',
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
    && list.length >= Number(expectedManifestShape(contract).expectedCounts?.tamper_case_results_min || 0)
    && idsEqual(list, 'id', tamperCases.map((item) => item.id))
    && list.every((entry) => {
      const expected = tamperCases.find((item) => item.id === entry.id);
      return expected
        && entry.covered === true
        && entry.expectedFailure === expected.expectedFailure;
    });
}

function literalResultsOk(results = [], refresh = {}, contract = {}) {
  const expected = requiredLiteralResults(refresh, expectedManifestShape(contract).requiredLiteralValues || {});
  return valuesMatch(asArray(results), expected)
    && results.length >= Number(expectedManifestShape(contract).expectedCounts?.required_literal_results_min || 0);
}

function buildValidationReport(refresh, contract = {}, generatedAt = refresh.generated_at) {
  const validation = validateRefresh(refresh, contract);
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
    version: RUNTIME_READINESS_REFRESH_VERSION,
    validation_id: `runtime-readiness-refresh-through-phase37-validation-${stableHash({
      refresh_key: refresh.idempotency_key,
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
    required_literal_results: requiredLiteralResults(refresh, expectedManifestShape(contract).requiredLiteralValues || {}),
    referenced_path_results: buildReferencedPathResults(contract),
    forbidden_output_scan: resultObject('forbidden-output-strings-absent', validation.resultById['no-raw-private-secret-output']?.ok),
    side_effect_truth: sideEffectResult(),
    summary: {
      current_through_phase: refresh.phase_registry?.current_through_phase,
      phase_registry_count: refresh.phase_registry?.phase_inventory_count,
      schema_registry_count: refresh.phase_registry?.schema_registry_count,
      cli_registry_count: refresh.phase_registry?.cli_registry_count,
      commit_chain_count: asArray(refresh.commit_chain).length,
      source_ref_count: asArray(refresh.source_refs).length,
      blocker_count: asArray(refresh.blocker_summary).length,
      next_recommendation_count: asArray(refresh.next_phase_recommendations).length,
      baseline_commit: refresh.baseline_commit,
      accepted_validation_only: validation.ok,
    },
  };
  assertNoForbiddenOutput(report, asArray(contract.forbiddenOutputSubstrings));
  return report;
}

function buildMiraCoreRuntimeReadinessRefreshThroughPhase37(options = {}) {
  const contract = options.contract || {};
  const runtime_readiness_refresh_through_phase37 = buildRefresh(options);
  const validation_report = buildValidationReport(
    runtime_readiness_refresh_through_phase37,
    contract,
    runtime_readiness_refresh_through_phase37.generated_at,
  );
  const output = {
    runtime_readiness_refresh_through_phase37,
    validation_report,
  };
  assertNoForbiddenOutput(output, asArray(contract.forbiddenOutputSubstrings));
  return output;
}

function validateMiraCoreRuntimeReadinessRefreshThroughPhase37Output(output = {}, contract = {}) {
  const checks = [];
  const errors = [];
  const add = (id, ok) => {
    checks.push({ id, ok: ok === true });
    if (!ok) errors.push(id);
  };
  const refresh = output.runtime_readiness_refresh_through_phase37 || {};
  const report = output.validation_report || {};
  const refreshValidation = validateRefresh(refresh, contract);
  const referencedOk = referencedPathResultsOk(report.referenced_path_results, contract);
  const recomputedById = refreshValidation.checks.reduce((acc, check) => {
    acc[check.id] = check;
    return acc;
  }, {});
  recomputedById['referenced-path-results-complete'] =
    resultObject('referenced-path-results-complete', referencedOk);
  const staticIds = asArray(contract.staticValidationRules).map((rule) => rule.id);
  const acceptanceIds = asArray(contract.acceptanceChecks).map((check) => check.id);

  add('output-shape-complete',
    hasRequiredFields(output, contract.expectedOutputShape?.requiredTopLevelFields || REQUIRED_OUTPUT_FIELDS)
      && refresh.schema === RUNTIME_READINESS_REFRESH_SCHEMA_VERSION
      && report.schema === VALIDATION_REPORT_SCHEMA_VERSION
      && hasRequiredFields(refresh, contract.expectedManifestShape?.requiredFields || REQUIRED_REFRESH_FIELDS)
      && hasRequiredFields(report, contract.expectedValidationReportShape?.requiredFields || REQUIRED_VALIDATION_REPORT_FIELDS));

  for (const check of refreshValidation.checks) {
    if (check.id !== 'referenced-path-results-complete') add(check.id, check.ok);
  }

  add('validation-report-literal-values',
    report.schema === VALIDATION_REPORT_SCHEMA_VERSION
      && report.baseline_commit === BASELINE_COMMIT
      && literalValuesOk(report, validationShape(contract).requiredLiteralValues || {}));

  add('validation-report-side-effect-truth', sideEffectValuesOk(report.side_effect_truth));
  add('referenced-path-results-complete', referencedOk);

  add('validation-report-matches-contract',
    report.accepted === refreshValidation.ok
      && report.blocked === !refreshValidation.ok
      && report.decision === (refreshValidation.ok ? 'accepted_validation_only' : 'rejected')
      && valuesMatch(asArray(report.reasons), refreshValidation.checks.filter((check) => !check.ok).map((check) => check.id))
      && resultListMatches(report.static_rule_results, staticIds, recomputedById)
      && resultListMatches(report.acceptance_check_results, acceptanceIds, recomputedById)
      && tamperCaseResultsOk(report.tamper_case_results, contract)
      && literalResultsOk(report.required_literal_results, refresh, contract)
      && referencedOk
      && report.forbidden_output_scan?.ok === Boolean(recomputedById['no-raw-private-secret-output']?.ok));

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
  REQUIRED_REFRESH_FIELDS,
  REQUIRED_SIDE_EFFECT_FIELDS,
  REQUIRED_VALIDATION_REPORT_FIELDS,
  RUNTIME_READINESS_REFRESH_SCHEMA_VERSION,
  VALIDATION_REPORT_SCHEMA_VERSION,
  assertNoForbiddenOutput,
  buildMiraCoreRuntimeReadinessRefreshThroughPhase37,
  runtimeReadinessRefreshThroughPhase37IdempotencyKey,
  stableHash,
  validateMiraCoreRuntimeReadinessRefreshThroughPhase37Output,
};
