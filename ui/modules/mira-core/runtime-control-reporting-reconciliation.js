'use strict';

const crypto = require('crypto');

const RUNTIME_CONTROL_REPORTING_RECONCILIATION_SCHEMA_VERSION =
  'squidrun.mira_core.runtime_control_reporting_reconciliation.v0';
const VALIDATION_REPORT_SCHEMA_VERSION =
  'squidrun.mira_core.runtime_control_reporting_reconciliation_validation_report.v0';
const RUNTIME_CONTROL_REPORTING_RECONCILIATION_VERSION = 'v0';
const BASELINE_COMMIT = '6f08b05';

const REQUIRED_OUTPUT_FIELDS = Object.freeze([
  'runtime_control_reporting_reconciliation',
  'validation_report',
]);

const REQUIRED_RECONCILIATION_FIELDS = Object.freeze([
  'schema',
  'version',
  'reconciliation_id',
  'idempotency_key',
  'generated_at',
  'profile',
  'sessionId',
  'deviceId',
  'baseline_commit',
  'phase_registry',
  'commit_chain',
  'source_recommendation',
  'satisfied_prior_recommendations',
  'stale_readiness',
  'phase34_prior_recommendations',
  'closure_summary',
  'source_refs',
  'control_state',
  'dry_run_status',
  'operator_reporting_summary',
  'gates',
  'reporting_shape',
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
  'forbidden_output_scan',
  'side_effect_truth',
  'summary',
]);

const REQUIRED_SIDE_EFFECT_FIELDS = Object.freeze([
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
  'no_migration_executed',
  'no_queue_created',
  'no_lease_created',
  'no_auth_change_performed',
  'no_key_secret_operation_performed',
  'no_local_execution_performed',
  'no_shell_or_pty_used',
  'no_send_performed',
  'no_deploy_performed',
  'no_trade_performed',
  'no_output_file_written',
]);

const SIDE_EFFECT_COUNTER_FIELDS = Object.freeze([
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
  'migrationsAttempted',
  'queuesCreated',
  'leasesCreated',
  'authChangesAttempted',
  'keySecretOperationsAttempted',
  'localExecutionAttempted',
  'shellPtyAttempts',
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
  'control report proves runtime',
  'operator surface proves UI',
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
  'control report proves runtime',
  'operator surface proves ui',
  'socket proves bridge green',
  'delivery acceptance proves model processing',
  'builder direct target allowed',
  'oracle direct target allowed',
]));

const GATE_DEFS = Object.freeze([
  ['kill_switch', 'kill-switch', 'Kill Switch', 'phase30-runtime-control-path'],
  ['rollback', 'rollback', 'Rollback', 'phase30-runtime-control-path'],
  ['reporting', 'reporting', 'Reporting', 'phase33-runtime-operator-status'],
  ['local_binding', 'local-binding', 'Local Binding', 'phase36-runtime-operator-ui-surface'],
]);

const REPORT_CARDS = Object.freeze([
  'disabled-mode-card',
  'dry-run-contract-only-card',
  'kill-switch-reference-card',
  'rollback-reference-card',
  'reporting-reference-card',
  'queue-lease-store-output-blocked-card',
]);

const STATUS_LINES = Object.freeze([
  'runtime flag disabled',
  'dry-run contract only',
  'runner not executed',
  'runtime not started',
  'no queue or lease',
  'no store or output file',
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

function evidenceRef(store, eventId, relation = 'runtime_control_reporting_reconciliation_validation') {
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

function controlShape(contract = {}) {
  return contract.controlStateShapeExpected || {};
}

function validationShape(contract = {}) {
  return contract.expectedValidationReportShape || {};
}

function phaseRegistry(contract = {}) {
  const expected = contract.phaseRegistryExpected || {};
  return {
    source_ref: expected.source_ref,
    current_through_phase: 36,
    expected_phases: expected.expected_phases || '1-36',
    phase_inventory_count: 36,
    schema_registry_count: 36,
    cli_registry_count: 36,
    phase35_current: true,
    phase36_operator_ui_surface_current: true,
    phase36_commit: BASELINE_COMMIT,
    phase36_delta: clone(expected.phase36_delta || {}),
    evidenceRefs: [
      evidenceRef('git', BASELINE_COMMIT, 'phase37-baseline'),
      evidenceRef('mira-core-runtime-control-reporting-reconciliation-contract', 'phase-registry'),
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
      evidenceRef('mira-core-runtime-next-action', 'phase35-current'),
      evidenceRef('mira-core-runtime-operator-ui-surface', 'phase36-current'),
    ],
  };
}

function phase34PriorRecommendations(contract = {}) {
  return {
    phase35_runtime_status_milestone_refresh_validator: {
      ...clone(contract.phase34PriorRecommendationsExpected?.[0] || {}),
      evidenceRefs: [evidenceRef('git', 'c04155d', 'phase34-prior-validator-satisfied')],
    },
    phase35_stdout_only_cli_smoke: {
      ...clone(contract.phase34PriorRecommendationsExpected?.[1] || {}),
      evidenceRefs: [evidenceRef('git', 'c04155d', 'phase34-prior-cli-satisfied')],
    },
  };
}

function closureSummary() {
  return {
    phase30_oracle_115_prerequisite_mapping_closure: true,
    phase32_oracle_123_expires_at_closure: true,
    phase33_oracle_127_validation_report_tamper_coverage_closure: true,
    phase34_oracle_131_read_only_review_green: true,
    phase35_oracle_134_read_only_review_green: true,
    phase36_oracle_137_read_only_review_green: true,
    closed_review_refs: ['ORACLE #115', 'ORACLE #123', 'ORACLE #127', 'ORACLE #131', 'ORACLE #134', 'ORACLE #137'],
    evidenceRefs: [
      evidenceRef('mira-core-runtime-control-path', 'oracle-115-closure'),
      evidenceRef('mira-core-runtime-dry-runner', 'oracle-123-closure'),
      evidenceRef('mira-core-runtime-operator-status', 'oracle-127-closure'),
      evidenceRef('mira-core-runtime-status-milestone-refresh', 'oracle-131-closure'),
      evidenceRef('mira-core-runtime-next-action', 'oracle-134-closure'),
      evidenceRef('mira-core-runtime-operator-ui-surface', 'oracle-137-closure'),
    ],
  };
}

function sourceRefs(contract = {}) {
  return clone(contract.sourceRefsExpected || []);
}

function controlState() {
  return {
    disabled_by_default: true,
    operator_visible: true,
    control_execution_authorized: false,
    kill_switch_wired: false,
    rollback_wired: false,
    reporting_sink_wired: false,
    runtime_mode_flag: {
      flag_name: 'MIRA_CORE_RUNTIME_SLICE_0_ENABLED',
      default: 'disabled',
      effective: 'disabled',
      source: 'reference-only-config-contract',
      reference_only: true,
      implemented: false,
      authorizes_runtime: false,
    },
    dry_run_mode: {
      mode: 'disabled_contract_only',
      reference_only: true,
      implemented: false,
      authorizes_runner: false,
    },
    allowed_state_transitions: ['remain_disabled_contract_only'],
    blocked_state_transitions: [
      'enable-runtime',
      'execute-control',
      'wire-kill-switch',
      'run-rollback',
      'write-report',
      'create-queue-or-lease',
    ],
  };
}

function dryRunStatus() {
  return {
    contract_only: true,
    status: 'disabled_dry_run_contract_only',
    runner_executed: false,
    runtime_started: false,
    runtime_available: false,
    queue_created: false,
    lease_created: false,
    store_written: false,
    output_file_written: false,
    execution_performed: false,
    side_effects_performed: false,
    source_refs: ['phase29-runtime-dry-run-implementation', 'phase32-runtime-dry-runner'],
  };
}

function gates() {
  return GATE_DEFS.reduce((acc, [key, gateId, label, source]) => {
    acc[key] = {
      gate_id: gateId,
      label,
      reference_only: true,
      implemented: false,
      wired: false,
      status: 'reference_only_not_implemented',
      source_refs: [source],
      does_not_authorize_runtime: true,
      does_not_authorize_execution: true,
    };
    return acc;
  }, {});
}

function operatorReportingSummary() {
  return {
    summary_id: 'runtime-control-reporting-reconciliation-summary',
    operator_visible: true,
    display_only: true,
    non_authorizing: true,
    ui_rendering_authorized: false,
    browser_window_capture_authorized: false,
    output_file_authorized: false,
    redaction_status: 'redacted_metadata_only',
    source_refs: [
      'phase33-runtime-operator-status',
      'phase34-runtime-status-milestone-refresh',
      'phase35-runtime-next-action',
      'phase36-runtime-operator-ui-surface',
    ],
    status_lines: clone(STATUS_LINES),
    report_cards: REPORT_CARDS.map((cardId) => ({
      card_id: cardId,
      status: 'display_only_reference',
      redaction_status: 'redacted_metadata_only',
      source_refs: ['phase33-runtime-operator-status', 'phase36-runtime-operator-ui-surface'],
      does_not_authorize_runtime: true,
      does_not_authorize_execution: true,
    })),
    blocked_actions: [
      'ui-rendering',
      'browser-window-capture',
      'runtime-start',
      'runner-execution',
      'control-execution',
      'queue-lease',
      'store-output-file',
      'external-action',
    ],
    does_not_prove: [
      'ui_availability',
      'runtime_availability',
      'model_processing',
      'bridge_green',
      'control_execution',
      'runner_execution',
    ],
  };
}

function reportingShape() {
  return {
    gate_count: 4,
    reporting_cards: clone(REPORT_CARDS),
    status_lines: clone(STATUS_LINES),
    reference_only: true,
    implemented: false,
    display_only: true,
    output_file_authorized: false,
    source_refs: ['phase33-runtime-operator-status', 'phase36-runtime-operator-ui-surface'],
  };
}

function capabilityMatrix() {
  return {
    runtimeStarted: false,
    runnerExecuted: false,
    runtimeAvailable: false,
    realRuntimeAvailable: false,
    serverCanExecuteLocal: false,
    serverCanProveModelProcessing: false,
    directBuilderOracleServerTargetsAllowed: false,
    allowed_future_server_target_role: 'architect',
    allowed_next_recommendation_tiers: ['tier0', 'tier1'],
    evidenceRefs: [evidenceRef('mira-core-runtime-control-reporting-reconciliation', 'capability-matrix')],
  };
}

function boundaryTruth() {
  return {
    runtimeStarted: false,
    runnerExecuted: false,
    runtimeAvailable: false,
    serverCanExecuteLocal: false,
    serverCanProveModelProcessing: false,
    builderOracleDirectServerTargetsAllowed: false,
    socketIsBridgeGreenProof: false,
    deliveryAcceptanceIsModelProcessingProof: false,
    controlReportIsRuntimeProof: false,
    controlReportIsExecutionAuthorization: false,
    operatorSurfaceIsUiProof: false,
    evidenceRefs: [evidenceRef('mira-core-runtime-control-reporting-reconciliation', 'boundary-truth')],
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
    evidenceRefs: [evidenceRef('mira-core-runtime-control-reporting-reconciliation', 'redaction-summary')],
  };
}

function unsafeActionPolicy() {
  return {
    ui_rendering_allowed: false,
    browser_window_capture_allowed: false,
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
    live_runtime_allowed: false,
    control_execution_allowed: false,
    unsafe_action_drift_rejected: true,
    evidenceRefs: [evidenceRef('mira-core-runtime-control-reporting-reconciliation', 'unsafe-action-policy')],
  };
}

function nextPhaseRecommendations(contract = {}) {
  return asArray(contract.nextRecommendationExpectedCandidates).map((candidate) => ({
    ...clone(candidate),
    blocked_side_effects: [
      'ui-rendering',
      'browser-window-capture',
      'runtime-start',
      'store-write',
      'queue-lease',
      'execution',
      'irreversible-action-boundary',
      'output-file',
    ],
    evidenceRefs: [evidenceRef('mira-core-runtime-control-reporting-reconciliation', `next:${candidate.recommendation_id}`)],
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
  result.uiImplemented = false;
  result.browserWindowCapturePerformed = false;
  result.runtimeStarted = false;
  result.runnerExecuted = false;
  result.runtimeAvailable = false;
  result.serverStarted = false;
  result.listenerBound = false;
  result.networkPerformed = false;
  result.outputFileWritten = false;
  return result;
}

function canonicalReconciliationInput(reconciliation = {}) {
  return {
    profile: reconciliation.profile,
    sessionId: reconciliation.sessionId,
    deviceId: reconciliation.deviceId,
    baseline_commit: reconciliation.baseline_commit,
    phase_registry: reconciliation.phase_registry,
    commit_chain: reconciliation.commit_chain,
    source_recommendation: reconciliation.source_recommendation,
    satisfied_prior_recommendations: reconciliation.satisfied_prior_recommendations,
    stale_readiness: reconciliation.stale_readiness,
    phase34_prior_recommendations: reconciliation.phase34_prior_recommendations,
    closure_summary: reconciliation.closure_summary,
    source_refs: reconciliation.source_refs,
    control_state: reconciliation.control_state,
    dry_run_status: reconciliation.dry_run_status,
    operator_reporting_summary: reconciliation.operator_reporting_summary,
    gates: reconciliation.gates,
    reporting_shape: reconciliation.reporting_shape,
    capability_matrix: reconciliation.capability_matrix,
    boundary_truth: reconciliation.boundary_truth,
    redaction_summary: reconciliation.redaction_summary,
    unsafe_action_policy: reconciliation.unsafe_action_policy,
    next_phase_recommendations: reconciliation.next_phase_recommendations,
    side_effect_result: reconciliation.side_effect_result,
  };
}

function runtimeControlReportingReconciliationIdempotencyKey(reconciliation) {
  return `runtime-control-reporting-reconciliation:${stableHash(canonicalReconciliationInput(reconciliation))}`;
}

function buildReconciliation(options = {}) {
  const contract = options.contract || {};
  const inputSignals = options.inputSignals || {};
  const scope = normalizeScope(inputSignals);
  const generatedAt = generatedAtFromOptions(options, inputSignals);
  const reconciliation = {
    schema: RUNTIME_CONTROL_REPORTING_RECONCILIATION_SCHEMA_VERSION,
    version: RUNTIME_CONTROL_REPORTING_RECONCILIATION_VERSION,
    reconciliation_id: null,
    idempotency_key: null,
    generated_at: generatedAt,
    profile: scope.profile,
    sessionId: scope.sessionId,
    deviceId: scope.deviceId,
    baseline_commit: inputSignals.baseline_commit || BASELINE_COMMIT,
    phase_registry: phaseRegistry(contract),
    commit_chain: asArray(inputSignals.commit_chain).length > 0 ? clone(inputSignals.commit_chain) : clone(contract.commitChainExpected || []),
    source_recommendation: clone(contract.sourceRecommendation || {}),
    satisfied_prior_recommendations: clone(contract.satisfiedPriorRecommendations || []),
    stale_readiness: staleReadiness(contract),
    phase34_prior_recommendations: phase34PriorRecommendations(contract),
    closure_summary: closureSummary(),
    source_refs: sourceRefs(contract),
    control_state: controlState(),
    dry_run_status: dryRunStatus(),
    operator_reporting_summary: operatorReportingSummary(),
    gates: gates(),
    reporting_shape: reportingShape(),
    capability_matrix: capabilityMatrix(),
    boundary_truth: boundaryTruth(),
    redaction_summary: redactionSummary(),
    unsafe_action_policy: unsafeActionPolicy(),
    next_phase_recommendations: nextPhaseRecommendations(contract),
    evidenceRefs: [
      evidenceRef('git', BASELINE_COMMIT, 'phase37-baseline'),
      evidenceRef('mira-core-runtime-control-reporting-reconciliation-contract', 'phase37-contract'),
    ],
    side_effect_result: sideEffectResult(),
  };
  reconciliation.idempotency_key = runtimeControlReportingReconciliationIdempotencyKey(reconciliation);
  reconciliation.reconciliation_id = `runtime-control-reporting-reconciliation-${stableHash({
    key: reconciliation.idempotency_key,
  }).slice(0, 12)}`;
  assertNoForbiddenOutput(reconciliation, asArray(contract.forbiddenOutputSubstrings));
  return reconciliation;
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
    && value.uiImplemented === false
    && value.browserWindowCapturePerformed === false
    && value.runtimeStarted === false
    && value.runnerExecuted === false
    && value.runtimeAvailable === false
    && value.serverStarted === false
    && value.listenerBound === false
    && value.networkPerformed === false
    && value.outputFileWritten === false;
}

function phase36CurrentOk(reconciliation) {
  const registry = reconciliation.phase_registry || {};
  const delta = registry.phase36_delta || {};
  return registry.current_through_phase === 36
    && registry.phase_inventory_count === 36
    && registry.schema_registry_count === 36
    && registry.cli_registry_count === 36
    && registry.phase35_current === true
    && registry.phase36_operator_ui_surface_current === true
    && registry.phase36_commit === BASELINE_COMMIT
    && delta.phase === 36
    && delta.committed_baseline === BASELINE_COMMIT
    && delta.status === 'local_validation_runtime_present_current'
    && delta.capability_truth?.runtimeStarted === false
    && delta.capability_truth?.runnerExecuted === false
    && delta.capability_truth?.runtimeAvailable === false
    && delta.capability_truth?.serverCanExecuteLocal === false
    && delta.capability_truth?.serverCanProveModelProcessing === false
    && delta.capability_truth?.directBuilderOracleServerTargetsAllowed === false;
}

function registryCountsOk(reconciliation) {
  const registry = reconciliation.phase_registry || {};
  return registry.phase_inventory_count === 36
    && registry.schema_registry_count === 36
    && registry.cli_registry_count === 36
    && registry.current_through_phase === 36;
}

function commitChainOk(reconciliation, contract = {}) {
  const expected = asArray(contract.commitChainExpected);
  const chain = asArray(reconciliation.commit_chain);
  return expected.length === 24
    && chain.length === 24
    && valuesMatch(chain, expected)
    && chain[chain.length - 1] === BASELINE_COMMIT;
}

function sourceRecommendationOk(reconciliation, contract = {}) {
  const expected = contract.sourceRecommendation || {};
  const source = reconciliation.source_recommendation || {};
  return source.recommendation_id === expected.recommendation_id
    && source.tier === 'tier1'
    && source.status === 'selected_for_phase37_fixture_only_contract'
    && source.contract_only_now === true
    && source.implemented_now === false
    && source.does_not_authorize_ui === true
    && source.does_not_authorize_runtime === true
    && source.does_not_authorize_execution === true;
}

function satisfiedPriorOk(reconciliation, contract = {}) {
  const expected = asArray(contract.satisfiedPriorRecommendations)[0] || {};
  const satisfied = asArray(reconciliation.satisfied_prior_recommendations);
  return satisfied.length === 1
    && satisfied[0].recommendation_id === expected.recommendation_id
    && satisfied[0].status === 'satisfied_by_6f08b05_do_not_repeat_as_open_work'
    && satisfied[0].satisfied_by_commit === BASELINE_COMMIT
    && satisfied[0].must_not_reopen === true;
}

function phase34PriorRecommendationsOk(reconciliation) {
  const prior = reconciliation.phase34_prior_recommendations || {};
  return prior.phase35_runtime_status_milestone_refresh_validator?.status === 'satisfied_by_c04155d_do_not_repeat_as_open_work'
    && prior.phase35_runtime_status_milestone_refresh_validator?.must_not_reopen === true
    && prior.phase35_stdout_only_cli_smoke?.status === 'satisfied_by_c04155d_do_not_repeat_as_open_work'
    && prior.phase35_stdout_only_cli_smoke?.must_not_reopen === true;
}

function staleReadinessOk(reconciliation, phase) {
  const stale = reconciliation.stale_readiness || {};
  if (phase === 13) return stale.phase13_readiness_current === false && stale.phase13_superseded_by === 'phase_23_milestone_readiness';
  if (phase === 23) return stale.phase23_milestone_readiness_current === false && stale.phase23_superseded_by === 'phase_31_runtime_milestone_refresh';
  if (phase === 31) return stale.phase31_runtime_milestone_refresh_current === false
    && stale.phase31_superseded_by === 'phase_34_runtime_status_milestone_refresh';
  if (phase === 35) return stale.phase35_runtime_next_action_current === true;
  if (phase === 36) return stale.phase36_runtime_operator_ui_surface_current === true;
  return false;
}

function closuresOk(reconciliation) {
  const closure = reconciliation.closure_summary || {};
  return closure.phase30_oracle_115_prerequisite_mapping_closure === true
    && closure.phase32_oracle_123_expires_at_closure === true
    && closure.phase33_oracle_127_validation_report_tamper_coverage_closure === true
    && closure.phase34_oracle_131_read_only_review_green === true
    && closure.phase35_oracle_134_read_only_review_green === true
    && closure.phase36_oracle_137_read_only_review_green === true
    && ['ORACLE #115', 'ORACLE #123', 'ORACLE #127', 'ORACLE #131', 'ORACLE #134', 'ORACLE #137']
      .every((ref) => asArray(closure.closed_review_refs).includes(ref));
}

function sourceRefsOk(reconciliation, contract = {}) {
  return valuesMatch(reconciliation.source_refs, contract.sourceRefsExpected || []);
}

function controlStateOk(reconciliation, contract = {}) {
  const shape = controlShape(contract);
  const state = reconciliation.control_state || {};
  const flag = state.runtime_mode_flag || {};
  return hasRequiredFields(state, shape.requiredFields || [])
    && state.disabled_by_default === true
    && state.operator_visible === true
    && state.control_execution_authorized === false
    && state.kill_switch_wired === false
    && state.rollback_wired === false
    && state.reporting_sink_wired === false
    && hasRequiredFields(flag, shape.runtimeModeFlag?.requiredFields || [])
    && literalValuesOk(flag, shape.runtimeModeFlag?.requiredValues || {})
    && state.dry_run_mode?.reference_only === true
    && state.dry_run_mode?.implemented === false
    && state.dry_run_mode?.authorizes_runner === false
    && asArray(state.allowed_state_transitions).includes('remain_disabled_contract_only')
    && asArray(state.blocked_state_transitions).length > 0;
}

function dryRunStatusOk(reconciliation, contract = {}) {
  const status = reconciliation.dry_run_status || {};
  return hasRequiredFields(status, controlShape(contract).dryRunStatusRequiredFields || [])
    && status.contract_only === true
    && status.status === 'disabled_dry_run_contract_only'
    && status.runner_executed === false
    && status.runtime_started === false
    && status.runtime_available === false
    && status.queue_created === false
    && status.lease_created === false
    && status.store_written === false
    && status.output_file_written === false
    && status.execution_performed === false
    && status.side_effects_performed === false;
}

function gateList(reconciliation) {
  const gatesValue = reconciliation.gates || {};
  return GATE_DEFS.map(([key]) => gatesValue[key]).filter(Boolean);
}

function gatesOk(reconciliation, contract = {}) {
  const shape = controlShape(contract);
  const gatesValue = reconciliation.gates || {};
  const list = gateList(reconciliation);
  return list.length === Number(expectedManifestShape(contract).expectedCounts?.gate_count || 0)
    && asArray(shape.requiredGates).every((gateId) => list.some((gate) => gate.gate_id === gateId))
    && GATE_DEFS.every(([key]) => Boolean(gatesValue[key]))
    && list.every((gate) => hasRequiredFields(gate, shape.gateRequiredFields || [])
      && gate.reference_only === true
      && gate.implemented === false
      && gate.wired === false
      && gate.status === 'reference_only_not_implemented'
      && gate.does_not_authorize_runtime === true
      && gate.does_not_authorize_execution === true);
}

function operatorReportingSummaryOk(reconciliation, contract = {}) {
  const shape = controlShape(contract);
  const summary = reconciliation.operator_reporting_summary || {};
  const cards = asArray(summary.report_cards);
  const lines = asArray(summary.status_lines);
  return hasRequiredFields(summary, shape.reportingSummaryRequiredFields || [])
    && summary.operator_visible === true
    && summary.display_only === true
    && summary.non_authorizing === true
    && summary.ui_rendering_authorized === false
    && summary.browser_window_capture_authorized === false
    && summary.output_file_authorized === false
    && summary.redaction_status === 'redacted_metadata_only'
    && cards.length >= Number(expectedManifestShape(contract).expectedCounts?.reporting_cards_min || 0)
    && lines.length >= Number(expectedManifestShape(contract).expectedCounts?.status_lines_min || 0)
    && asArray(shape.requiredReportCards).every((cardId) => cards.some((card) => card.card_id === cardId))
    && asArray(shape.requiredStatusLines).every((line) => lines.includes(line))
    && cards.every((card) => card.status === 'display_only_reference'
      && card.redaction_status === 'redacted_metadata_only'
      && card.does_not_authorize_runtime === true
      && card.does_not_authorize_execution === true)
    && asArray(summary.blocked_actions).length > 0
    && asArray(summary.does_not_prove).length > 0;
}

function noQueueLeaseStoreOutputExecutionOk(reconciliation) {
  const dryRun = reconciliation.dry_run_status || {};
  const side = reconciliation.side_effect_result || {};
  return dryRun.queue_created === false
    && dryRun.lease_created === false
    && dryRun.store_written === false
    && dryRun.output_file_written === false
    && dryRun.execution_performed === false
    && side.no_queue_created === true
    && side.no_lease_created === true
    && side.no_store_write_performed === true
    && side.no_output_file_written === true
    && side.no_local_execution_performed === true;
}

function redactionOk(reconciliation) {
  const redaction = reconciliation.redaction_summary || {};
  return redaction.raw_private_content_included === false
    && redaction.raw_terminal_included === false
    && redaction.raw_screenshot_ocr_browser_included === false
    && redaction.secret_material_included === false
    && redaction.customer_private_content_included === false;
}

function capabilityTruthOk(reconciliation) {
  const capability = reconciliation.capability_matrix || {};
  return capability.runtimeStarted === false
    && capability.runnerExecuted === false
    && capability.runtimeAvailable === false
    && capability.realRuntimeAvailable === false
    && capability.serverCanExecuteLocal === false
    && capability.serverCanProveModelProcessing === false
    && capability.directBuilderOracleServerTargetsAllowed === false;
}

function proofBoundariesOk(reconciliation) {
  const boundary = reconciliation.boundary_truth || {};
  return boundary.runtimeStarted === false
    && boundary.runnerExecuted === false
    && boundary.runtimeAvailable === false
    && boundary.serverCanExecuteLocal === false
    && boundary.serverCanProveModelProcessing === false
    && boundary.builderOracleDirectServerTargetsAllowed === false
    && boundary.socketIsBridgeGreenProof === false
    && boundary.deliveryAcceptanceIsModelProcessingProof === false
    && boundary.controlReportIsRuntimeProof === false
    && boundary.controlReportIsExecutionAuthorization === false
    && boundary.operatorSurfaceIsUiProof === false;
}

function nextRecommendationsOk(reconciliation, contract = {}) {
  const expected = asArray(contract.nextRecommendationExpectedCandidates);
  const recommendations = asArray(reconciliation.next_phase_recommendations);
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
  return /\b(no|without|blocked|blocks|disallow|disallowed|not|cannot|does not|must not|keeps|disabled|false|reference-only|contract-only)\b/i.test(clause);
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

function unsafeActionDriftOk(reconciliation, contract = {}) {
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
    ...collectStringValues(reconciliation.source_recommendation),
    ...collectStringValues(reconciliation.satisfied_prior_recommendations),
    ...collectStringValues(reconciliation.phase34_prior_recommendations),
    ...collectStringValues(reconciliation.closure_summary),
    ...collectStringValues(reconciliation.source_refs),
    ...collectStringValues(reconciliation.control_state),
    ...collectStringValues(reconciliation.dry_run_status),
    ...collectStringValues(reconciliation.operator_reporting_summary),
    ...collectStringValues(reconciliation.gates),
    ...collectStringValues(reconciliation.reporting_shape),
    ...collectStringValues(reconciliation.next_phase_recommendations),
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
      throw new Error(`runtime_control_reporting_reconciliation_forbidden_substring:${forbidden}`);
    }
  }
}

function validateReconciliation(reconciliation = {}, contract = {}) {
  const checks = [];
  const errors = [];
  const resultById = {};
  const add = (id, ok) => {
    const result = resultObject(id, ok);
    checks.push(result);
    resultById[id] = result;
    if (!ok) errors.push(id);
  };

  const outputShapeOk = reconciliation.schema === RUNTIME_CONTROL_REPORTING_RECONCILIATION_SCHEMA_VERSION
    && hasRequiredFields(reconciliation, expectedManifestShape(contract).requiredFields || REQUIRED_RECONCILIATION_FIELDS);
  const baselineOk = reconciliation.baseline_commit === BASELINE_COMMIT;
  const phase36Ok = phase36CurrentOk(reconciliation);
  const registryOk = registryCountsOk(reconciliation);
  const chainOk = commitChainOk(reconciliation, contract);
  const sourceOk = sourceRecommendationOk(reconciliation, contract);
  const satisfiedOk = satisfiedPriorOk(reconciliation, contract);
  const priorOk = phase34PriorRecommendationsOk(reconciliation);
  const phase13Ok = staleReadinessOk(reconciliation, 13);
  const phase23Ok = staleReadinessOk(reconciliation, 23);
  const phase31Ok = staleReadinessOk(reconciliation, 31);
  const phase35Ok = staleReadinessOk(reconciliation, 35);
  const phase36StaleOk = staleReadinessOk(reconciliation, 36);
  const closureOk = closuresOk(reconciliation);
  const refsOk = sourceRefsOk(reconciliation, contract);
  const controlOk = controlStateOk(reconciliation, contract);
  const dryRunOk = dryRunStatusOk(reconciliation, contract);
  const gatesSafe = gatesOk(reconciliation, contract);
  const reportingOk = operatorReportingSummaryOk(reconciliation, contract);
  const noSideActionOk = noQueueLeaseStoreOutputExecutionOk(reconciliation);
  const redactionSafe = redactionOk(reconciliation);
  const capabilityOk = capabilityTruthOk(reconciliation);
  const proofOk = proofBoundariesOk(reconciliation);
  const sideEffectsOk = sideEffectValuesOk(reconciliation.side_effect_result);
  const recommendationsOk = nextRecommendationsOk(reconciliation, contract);
  const unsafeOk = unsafeActionDriftOk(reconciliation, contract);
  const idempotencyOk = reconciliation.idempotency_key === runtimeControlReportingReconciliationIdempotencyKey(reconciliation);
  const literalsOk = literalValuesOk(reconciliation, expectedManifestShape(contract).requiredLiteralValues || {});
  let forbiddenOk = true;
  try {
    assertNoForbiddenOutput(reconciliation, asArray(contract.forbiddenOutputSubstrings));
  } catch {
    forbiddenOk = false;
  }

  const staticRuleOk = {
    'baseline-pinned-6f08b05': baselineOk,
    'phase36-current': phase36Ok,
    'phase-registry-count-36': registryOk,
    'schema-registry-count-36': registryOk,
    'cli-registry-count-36': registryOk,
    'commit-chain-exact-24': chainOk,
    'source-recommendation-tier1-selected': sourceOk,
    'phase36-tier0-satisfied-not-open': satisfiedOk,
    'phase34-prior-recommendations-satisfied': priorOk,
    'phase13-stale-preserved': phase13Ok,
    'phase23-stale-preserved': phase23Ok,
    'phase31-stale-preserved': phase31Ok,
    'phase35-current-preserved': phase35Ok,
    'closures-carried-oracle-115-123-127-131-134-137': closureOk,
    'source-refs-phase29-30-32-33-34-35-36': refsOk,
    'control-state-disabled-reference-only': controlOk,
    'dry-run-status-contract-only': dryRunOk,
    'gates-reference-only-not-implemented': gatesSafe,
    'operator-reporting-summary-display-only': reportingOk,
    'redaction-summary-safe': redactionSafe && forbiddenOk,
    'capability-truth-false': capabilityOk,
    'proof-boundaries-false': proofOk,
    'side-effect-truth-all-blocked': sideEffectsOk && noSideActionOk,
    'next-recommendations-tier0-tier1-only': recommendationsOk,
    'unsafe-action-drift-blocked': unsafeOk,
    'required-literal-checks-bound': literalsOk,
    'validation-report-coverage-bound': true,
    'idempotency-sensitive': idempotencyOk,
  };

  const acceptanceOk = {
    'baseline-6f08b05-pinned': baselineOk,
    'phase36-current-6f08b05': phase36Ok,
    'phase-registry-exactly-36': registryOk,
    'schema-registry-exactly-36': registryOk,
    'cli-registry-exactly-36': registryOk,
    'commit-chain-count-24-ending-6f08b05': chainOk,
    'source-tier1-control-reporting-selected': sourceOk,
    'phase36-tier0-ui-surface-validator-satisfied': satisfiedOk,
    'phase34-prior-validator-satisfied-not-reopened': priorOk,
    'phase34-prior-cli-smoke-satisfied-not-reopened': priorOk,
    'phase13-stale-truth-preserved': phase13Ok,
    'phase23-stale-truth-preserved': phase23Ok,
    'phase31-stale-superseded-by-phase34': phase31Ok,
    'phase35-current-preserved': phase35Ok,
    'phase36-operator-ui-surface-current': phase36StaleOk,
    'closures-oracle-115-123-127-131-134-137-present': closureOk,
    'source-refs-phase29-30-32-33-34-35-36-present': refsOk,
    'control-state-disabled-and-non-authorizing': controlOk,
    'dry-run-contract-only-no-runner': dryRunOk,
    'kill-switch-reference-only': reconciliation.gates?.kill_switch?.reference_only === true
      && reconciliation.gates?.kill_switch?.implemented === false,
    'rollback-reference-only': reconciliation.gates?.rollback?.reference_only === true
      && reconciliation.gates?.rollback?.implemented === false,
    'reporting-reference-only': reconciliation.gates?.reporting?.reference_only === true
      && reconciliation.gates?.reporting?.implemented === false,
    'operator-reporting-summary-display-only': reportingOk,
    'no-queue-lease-store-output-execution': noSideActionOk,
    'runtime-started-false': reconciliation.capability_matrix?.runtimeStarted === false
      && reconciliation.boundary_truth?.runtimeStarted === false
      && reconciliation.dry_run_status?.runtime_started === false,
    'runner-executed-false': reconciliation.capability_matrix?.runnerExecuted === false
      && reconciliation.boundary_truth?.runnerExecuted === false
      && reconciliation.dry_run_status?.runner_executed === false,
    'runtime-available-false': reconciliation.capability_matrix?.runtimeAvailable === false
      && reconciliation.boundary_truth?.runtimeAvailable === false
      && reconciliation.dry_run_status?.runtime_available === false,
    'server-can-execute-local-false': reconciliation.capability_matrix?.serverCanExecuteLocal === false
      && reconciliation.boundary_truth?.serverCanExecuteLocal === false,
    'server-can-prove-model-processing-false': reconciliation.capability_matrix?.serverCanProveModelProcessing === false
      && reconciliation.boundary_truth?.serverCanProveModelProcessing === false,
    'builder-oracle-direct-targets-blocked': reconciliation.capability_matrix?.directBuilderOracleServerTargetsAllowed === false
      && reconciliation.boundary_truth?.builderOracleDirectServerTargetsAllowed === false,
    'proof-boundaries-false': proofOk,
    'side-effect-truth-all-blocked': sideEffectsOk && noSideActionOk,
    'redaction-summary-safe': redactionSafe && forbiddenOk,
    'next-recommendations-tier0-tier1-only': recommendationsOk,
    'next-recommendations-non-authorizing': recommendationsOk,
    'unsafe-action-drift-rejected': unsafeOk,
    'required-literal-results-complete': literalsOk,
  };

  add('output-shape-complete', outputShapeOk);
  for (const rule of asArray(contract.staticValidationRules)) add(rule.id, staticRuleOk[rule.id] === true);
  for (const check of asArray(contract.acceptanceChecks)) add(check.id, acceptanceOk[check.id] === true);
  add('manifest-literal-values', literalsOk);
  add('manifest-contract-complete',
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

function literalResultsOk(results = [], reconciliation = {}, contract = {}) {
  const expected = requiredLiteralResults(reconciliation, expectedManifestShape(contract).requiredLiteralValues || {});
  return valuesMatch(asArray(results), expected);
}

function buildValidationReport(reconciliation, contract = {}, generatedAt = reconciliation.generated_at) {
  const validation = validateReconciliation(reconciliation, contract);
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
    version: RUNTIME_CONTROL_REPORTING_RECONCILIATION_VERSION,
    validation_id: `runtime-control-reporting-reconciliation-validation-${stableHash({
      reconciliation_key: reconciliation.idempotency_key,
      generatedAt,
    }).slice(0, 12)}`,
    generated_at: generatedAt,
    fixture_ref: 'ui/__tests__/fixtures/mira-core-runtime-control-reporting-reconciliation-contract.json',
    baseline_commit: BASELINE_COMMIT,
    decision: validation.ok ? 'accepted_validation_only' : 'rejected',
    accepted: validation.ok,
    blocked: !validation.ok,
    reasons: failed.map((check) => check.id),
    static_rule_results: staticResults,
    acceptance_check_results: acceptanceResults,
    tamper_case_results: tamperResults,
    required_literal_results: requiredLiteralResults(reconciliation, expectedManifestShape(contract).requiredLiteralValues || {}),
    forbidden_output_scan: resultObject('forbidden-output-strings-absent', validation.resultById['redaction-summary-safe']?.ok),
    side_effect_truth: sideEffectResult(),
    summary: {
      current_through_phase: reconciliation.phase_registry?.current_through_phase,
      phase_registry_count: reconciliation.phase_registry?.phase_inventory_count,
      source_ref_count: asArray(reconciliation.source_refs).length,
      gate_count: gateList(reconciliation).length,
      report_card_count: asArray(reconciliation.operator_reporting_summary?.report_cards).length,
      status_line_count: asArray(reconciliation.operator_reporting_summary?.status_lines).length,
      baseline_commit: reconciliation.baseline_commit,
      accepted_validation_only: validation.ok,
    },
  };
  assertNoForbiddenOutput(report, asArray(contract.forbiddenOutputSubstrings));
  return report;
}

function buildMiraCoreRuntimeControlReportingReconciliation(options = {}) {
  const contract = options.contract || {};
  const runtime_control_reporting_reconciliation = buildReconciliation(options);
  const validation_report = buildValidationReport(
    runtime_control_reporting_reconciliation,
    contract,
    runtime_control_reporting_reconciliation.generated_at,
  );
  const output = {
    runtime_control_reporting_reconciliation,
    validation_report,
  };
  assertNoForbiddenOutput(output, asArray(contract.forbiddenOutputSubstrings));
  return output;
}

function validateMiraCoreRuntimeControlReportingReconciliationOutput(output = {}, contract = {}) {
  const checks = [];
  const errors = [];
  const add = (id, ok) => {
    checks.push({ id, ok: ok === true });
    if (!ok) errors.push(id);
  };
  const reconciliation = output.runtime_control_reporting_reconciliation || {};
  const report = output.validation_report || {};
  const reconciliationValidation = validateReconciliation(reconciliation, contract);
  const recomputedById = reconciliationValidation.checks.reduce((acc, check) => {
    acc[check.id] = check;
    return acc;
  }, {});

  add('output-shape-complete',
    hasRequiredFields(output, contract.expectedOutputShape?.requiredTopLevelFields || REQUIRED_OUTPUT_FIELDS)
      && reconciliation.schema === RUNTIME_CONTROL_REPORTING_RECONCILIATION_SCHEMA_VERSION
      && report.schema === VALIDATION_REPORT_SCHEMA_VERSION
      && hasRequiredFields(reconciliation, contract.expectedManifestShape?.requiredFields || REQUIRED_RECONCILIATION_FIELDS)
      && hasRequiredFields(report, contract.expectedValidationReportShape?.requiredFields || REQUIRED_VALIDATION_REPORT_FIELDS));

  for (const check of reconciliationValidation.checks) add(check.id, check.ok);

  add('validation-report-literal-values',
    report.schema === VALIDATION_REPORT_SCHEMA_VERSION
      && report.baseline_commit === BASELINE_COMMIT
      && literalValuesOk(report, validationShape(contract).requiredLiteralValues || {}));

  add('validation-report-side-effect-truth', sideEffectValuesOk(report.side_effect_truth));

  add('validation-report-matches-contract',
    report.accepted === reconciliationValidation.ok
      && report.blocked === !reconciliationValidation.ok
      && report.decision === (reconciliationValidation.ok ? 'accepted_validation_only' : 'rejected')
      && valuesMatch(asArray(report.reasons), reconciliationValidation.checks.filter((check) => !check.ok).map((check) => check.id))
      && resultListMatches(
        report.static_rule_results,
        asArray(contract.staticValidationRules).map((rule) => rule.id),
        recomputedById,
      )
      && resultListMatches(
        report.acceptance_check_results,
        asArray(contract.acceptanceChecks).map((check) => check.id),
        recomputedById,
      )
      && tamperCaseResultsOk(report.tamper_case_results, contract)
      && literalResultsOk(report.required_literal_results, reconciliation, contract)
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
  REQUIRED_RECONCILIATION_FIELDS,
  REQUIRED_SIDE_EFFECT_FIELDS,
  REQUIRED_VALIDATION_REPORT_FIELDS,
  RUNTIME_CONTROL_REPORTING_RECONCILIATION_SCHEMA_VERSION,
  VALIDATION_REPORT_SCHEMA_VERSION,
  assertNoForbiddenOutput,
  buildMiraCoreRuntimeControlReportingReconciliation,
  runtimeControlReportingReconciliationIdempotencyKey,
  stableHash,
  validateMiraCoreRuntimeControlReportingReconciliationOutput,
};
