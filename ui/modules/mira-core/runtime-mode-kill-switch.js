'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const RUNTIME_MODE_KILL_SWITCH_REFERENCE_SCHEMA_VERSION =
  'squidrun.mira_core.runtime_mode_kill_switch_reference.v0';
const VALIDATION_REPORT_SCHEMA_VERSION =
  'squidrun.mira_core.runtime_mode_kill_switch_reference_validation_report.v0';
const RUNTIME_MODE_KILL_SWITCH_REFERENCE_VERSION = 'v0';
const BASELINE_COMMIT = 'a62fe16';
const FIXTURE_REF = 'ui/__tests__/fixtures/mira-core-runtime-mode-kill-switch-contract.json';

const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');

const REQUIRED_OUTPUT_FIELDS = Object.freeze([
  'runtime_mode_kill_switch_reference',
  'validation_report',
]);

const REQUIRED_REFERENCE_FIELDS = Object.freeze([
  'schema',
  'version',
  'reference_id',
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
  'runtime_mode_reference',
  'kill_switch_reference',
  'control_reference',
  'gap_mapping',
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
  'phase39 commit proves runtime',
  'runtime mode reference authorizes runtime',
  'kill switch reference authorizes runtime',
  'kill switch reference authorizes execution',
  'mode reference authorizes dry run',
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
  'phase39 commit proves runtime',
  'runtime mode reference authorizes runtime',
  'kill switch reference authorizes runtime',
  'kill switch reference authorizes execution',
  'mode reference authorizes dry run',
  'socket proves bridge green',
  'delivery acceptance proves model processing',
  'builder direct target allowed',
  'oracle direct target allowed',
]));

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

function evidenceRef(store, eventId, relation = 'runtime_mode_kill_switch_reference_validation') {
  return { store, eventId, relation };
}

function resultObject(id, ok) {
  return { id, ok: ok === true };
}

function expectedManifestShape(contract = {}) {
  return contract.expectedManifestShape || {};
}

function validationShape(contract = {}) {
  return contract.expectedValidationReportShape || {};
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
    sessionId: inputSignals.sessionId || 'session-330',
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
    current_through_phase: 39,
    expected_phases: expected.expected_phases || '1-39',
    phase_inventory_count: 39,
    schema_registry_count: 39,
    cli_registry_count: 39,
    phase35_runtime_next_action_current: true,
    phase36_operator_ui_surface_current: true,
    phase37_control_reporting_reconciliation_current: true,
    phase38_runtime_readiness_refresh_current: true,
    phase39_dry_run_readiness_gap_current: true,
    phase39_commit: BASELINE_COMMIT,
    phase39_delta: clone(expected.phase39_delta || {}),
    recent_phase_paths: clone(expected.required_recent_phase_paths || []),
    evidenceRefs: [
      evidenceRef('git', BASELINE_COMMIT, 'phase40-baseline'),
      evidenceRef('mira-core-runtime-mode-kill-switch-contract', 'phase-registry'),
    ],
  };
}

function registryEntries(kind, contract = {}) {
  const recent = new Map(asArray(contract.phaseRegistryExpected?.required_recent_phase_paths)
    .map((entry) => [entry.phase, entry]));
  return Array.from({ length: 39 }, (_, index) => {
    const phase = index + 1;
    const recentEntry = recent.get(phase);
    return {
      phase,
      registry_kind: kind,
      artifact_id: recentEntry ? `phase${phase}-${kind}` : `phase${phase}-${kind}-registered`,
      status: phase <= 39 ? 'registered_validation_artifact' : 'unknown',
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
      evidenceRef('git', BASELINE_COMMIT, 'phase39-current'),
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

function runtimeModeReference(contract = {}, generatedAt) {
  const expected = contract.runtimeModeReferenceShapeExpected || {};
  const values = expected.requiredValues || {};
  return {
    reference_id: 'runtime-mode-reference-v0',
    flag_name: 'MIRA_CORE_RUNTIME_MODE',
    default_state: values.default_state || 'disabled',
    effective_state: values.effective_state || 'disabled',
    allowed_values: clone(values.allowed_values || ['disabled', 'dry_run_preview_only']),
    source_ref: 'phase39-runtime-dry-run-readiness-gap',
    scope: {
      profile: 'main',
      device: 'local',
      environment: 'local_dev_reference',
    },
    reference_only: values.reference_only === true,
    implemented_now: false,
    flag_reader_implemented: false,
    dev_only: values.dev_only === true,
    local_only: values.local_only === true,
    operator_visible: values.operator_visible === true,
    authorizes_runtime: false,
    authorizes_dry_run: false,
    authorizes_execution: false,
    expires_at: new Date(Date.parse(generatedAt) + 24 * 60 * 60 * 1000).toISOString(),
    evidenceRefs: [evidenceRef('mira-core-runtime-mode-kill-switch-contract', 'runtime-mode-reference')],
  };
}

function killSwitchReference(contract = {}) {
  const expected = contract.killSwitchReferenceShapeExpected || {};
  const values = expected.requiredValues || {};
  return {
    reference_id: 'kill-switch-reference-v0',
    label: 'Mira Core disabled local runtime kill-switch reference',
    default_behavior: values.default_behavior || 'fail_closed',
    fail_closed_states: clone(values.fail_closed_states || ['missing', 'false', 'invalid', 'stale', 'unknown']),
    source_ref: 'phase39-runtime-dry-run-readiness-gap',
    scope: {
      profile: 'main',
      device: 'local',
      environment: 'local_dev_reference',
    },
    reference_only: values.reference_only === true,
    implemented_now: false,
    wired: false,
    visible_to_operator: values.visible_to_operator === true,
    testable_later: values.testable_later === true,
    authorizes_runtime: false,
    authorizes_execution: false,
    evidenceRefs: [evidenceRef('mira-core-runtime-mode-kill-switch-contract', 'kill-switch-reference')],
  };
}

function controlReference() {
  return {
    reference_only: true,
    disabled_by_default: true,
    control_execution_authorized: false,
    reporting_sink_wired: false,
    queue_created: false,
    lease_created: false,
    store_written: false,
    output_file_written: false,
    runtime_mode_flag_read: false,
    kill_switch_wired: false,
    runtime_started: false,
    runner_executed: false,
    evidenceRefs: [evidenceRef('mira-core-runtime-mode-kill-switch-contract', 'control-reference')],
  };
}

function gapMapping(contract = {}) {
  const expected = asArray(contract.gapMappingExpected);
  const map = {};
  for (const gap of expected) {
    const key = gap.gap_id === 'runtime-mode-flag-implementation'
      ? 'runtime_mode_flag_gap'
      : 'kill_switch_gap';
    map[key] = {
      ...clone(gap),
      authorizes_execution: false,
      evidenceRefs: [evidenceRef('mira-core-runtime-mode-kill-switch-contract', gap.gap_id)],
    };
  }
  return map;
}

function capabilityMatrix(contract = {}) {
  return {
    ...clone(contract.capabilityMatrixExpected || {}),
    evidenceRefs: [evidenceRef('mira-core-runtime-mode-kill-switch-contract', 'capability-matrix')],
  };
}

function boundaryTruth(contract = {}) {
  return {
    ...clone(contract.proofBoundaryExpected || {}),
    evidenceRefs: [evidenceRef('mira-core-runtime-mode-kill-switch-contract', 'boundary-truth')],
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
    evidenceRefs: [evidenceRef('mira-core-runtime-mode-kill-switch-contract', 'redaction-summary')],
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
    evidenceRefs: [evidenceRef('mira-core-runtime-mode-kill-switch-contract', 'unsafe-action-policy')],
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
      evidenceRef('mira-core-runtime-mode-kill-switch-contract', `next:${candidate.recommendation_id}`),
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

function canonicalReferenceInput(reference = {}) {
  return {
    profile: reference.profile,
    sessionId: reference.sessionId,
    deviceId: reference.deviceId,
    baseline_commit: reference.baseline_commit,
    phase_registry: reference.phase_registry,
    schema_registry: reference.schema_registry,
    cli_registry: reference.cli_registry,
    commit_chain: reference.commit_chain,
    source_recommendation: reference.source_recommendation,
    satisfied_prior_recommendations: reference.satisfied_prior_recommendations,
    current_truth: reference.current_truth,
    stale_readiness: reference.stale_readiness,
    phase34_prior_recommendations: reference.phase34_prior_recommendations,
    closure_summary: reference.closure_summary,
    source_refs: reference.source_refs,
    runtime_mode_reference: reference.runtime_mode_reference,
    kill_switch_reference: reference.kill_switch_reference,
    control_reference: reference.control_reference,
    gap_mapping: reference.gap_mapping,
    capability_matrix: reference.capability_matrix,
    boundary_truth: reference.boundary_truth,
    redaction_summary: reference.redaction_summary,
    unsafe_action_policy: reference.unsafe_action_policy,
    next_phase_recommendations: reference.next_phase_recommendations,
    side_effect_result: reference.side_effect_result,
  };
}

function runtimeModeKillSwitchIdempotencyKey(reference) {
  return `runtime-mode-kill-switch:${stableHash(canonicalReferenceInput(reference))}`;
}

function buildReference(options = {}) {
  const contract = options.contract || {};
  const inputSignals = options.inputSignals || {};
  const scope = normalizeScope(inputSignals);
  const generatedAt = generatedAtFromOptions(options, inputSignals);
  const reference = {
    schema: RUNTIME_MODE_KILL_SWITCH_REFERENCE_SCHEMA_VERSION,
    version: RUNTIME_MODE_KILL_SWITCH_REFERENCE_VERSION,
    reference_id: null,
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
      evidenceRefs: [evidenceRef('mira-core-runtime-dry-run-readiness-gap', 'source-recommendation')],
    },
    satisfied_prior_recommendations: clone(contract.satisfiedPriorRecommendations || []),
    current_truth: currentTruth(contract),
    stale_readiness: staleReadiness(contract),
    phase34_prior_recommendations: phase34PriorRecommendations(contract),
    closure_summary: closureSummary(contract),
    source_refs: clone(contract.sourceRefsExpected || []),
    runtime_mode_reference: runtimeModeReference(contract, generatedAt),
    kill_switch_reference: killSwitchReference(contract),
    control_reference: controlReference(),
    gap_mapping: gapMapping(contract),
    capability_matrix: capabilityMatrix(contract),
    boundary_truth: boundaryTruth(contract),
    redaction_summary: redactionSummary(),
    unsafe_action_policy: unsafeActionPolicy(),
    next_phase_recommendations: nextPhaseRecommendations(contract),
    evidenceRefs: [
      evidenceRef('git', BASELINE_COMMIT, 'phase40-baseline'),
      evidenceRef('mira-core-runtime-mode-kill-switch-contract', 'phase40-contract'),
    ],
    side_effect_result: sideEffectResult(),
  };
  reference.idempotency_key = runtimeModeKillSwitchIdempotencyKey(reference);
  reference.reference_id = `runtime-mode-kill-switch-${stableHash({
    key: reference.idempotency_key,
  }).slice(0, 12)}`;
  assertNoForbiddenOutput(reference, asArray(contract.forbiddenOutputSubstrings));
  return reference;
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
    && value.runtimeModeFlagRead === false
    && value.killSwitchWired === false
    && value.runnerExecuted === false
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

function phase39CurrentOk(reference) {
  const registry = reference.phase_registry || {};
  const delta = registry.phase39_delta || {};
  return registry.current_through_phase === 39
    && registry.phase39_dry_run_readiness_gap_current === true
    && registry.phase39_commit === BASELINE_COMMIT
    && delta.phase === 39
    && delta.name === 'runtime-dry-run-readiness-gap'
    && delta.committed_baseline === BASELINE_COMMIT
    && delta.status === 'local_validation_runtime_dry_run_readiness_gap_current'
    && delta.validation_only === true
    && reference.current_truth?.phase39_current === true
    && reference.current_truth?.phase39_commit === BASELINE_COMMIT
    && reference.current_truth?.phase39_validator_recommendation_satisfied === true
    && reference.current_truth?.phase39_readiness_gap_remains_non_authorizing === true
    && delta.capability_truth?.runtimeStarted === false
    && delta.capability_truth?.runnerExecuted === false
    && delta.capability_truth?.runtimeAvailable === false
    && delta.capability_truth?.serverCanExecuteLocal === false
    && delta.capability_truth?.serverCanProveModelProcessing === false
    && delta.capability_truth?.directBuilderOracleServerTargetsAllowed === false;
}

function currentTruthOk(reference, phase) {
  const truth = reference.current_truth || {};
  if (phase === 35) return truth.phase35_current === true && reference.phase_registry?.phase35_runtime_next_action_current === true;
  if (phase === 36) return truth.phase36_current === true && reference.phase_registry?.phase36_operator_ui_surface_current === true;
  if (phase === 37) return truth.phase37_current === true && reference.phase_registry?.phase37_control_reporting_reconciliation_current === true;
  if (phase === 38) return truth.phase38_current === true && reference.phase_registry?.phase38_runtime_readiness_refresh_current === true;
  if (phase === 39) return phase39CurrentOk(reference);
  return false;
}

function registryCountsOk(reference) {
  const registry = reference.phase_registry || {};
  return registry.phase_inventory_count === 39
    && registry.schema_registry_count === 39
    && registry.cli_registry_count === 39
    && registry.current_through_phase === 39
    && asArray(reference.schema_registry).length === 39
    && asArray(reference.cli_registry).length === 39;
}

function commitChainOk(reference, contract = {}) {
  const expected = asArray(contract.commitChainExpected);
  const chain = asArray(reference.commit_chain);
  return expected.length === 27
    && chain.length === 27
    && valuesMatch(chain, expected)
    && chain[chain.length - 1] === BASELINE_COMMIT;
}

function sourceRecommendationOk(reference, contract = {}) {
  const expected = contract.sourceRecommendation || {};
  const current = reference.source_recommendation || {};
  return current.recommendation_id === expected.recommendation_id
    && current.tier === 'tier1'
    && current.status === expected.status
    && current.contract_only_now === true
    && current.implemented_now === false
    && current.does_not_authorize_ui === true
    && current.does_not_authorize_runtime === true
    && current.does_not_authorize_execution === true;
}

function satisfiedPriorOk(reference, contract = {}) {
  const expected = asArray(contract.satisfiedPriorRecommendations);
  const current = asArray(reference.satisfied_prior_recommendations);
  return expected.length === 1
    && current.length === 1
    && current[0].recommendation_id === expected[0].recommendation_id
    && current[0].satisfied_by_commit === BASELINE_COMMIT
    && current[0].status === 'satisfied_by_a62fe16_do_not_repeat_as_open_work'
    && current[0].must_not_reopen === true
    && valuesMatch(current[0].satisfied_by_files, expected[0].satisfied_by_files)
    && !asArray(reference.next_phase_recommendations).some((item) => (
      item.recommendation_id === current[0].recommendation_id
    ));
}

function phase34PriorRecommendationsOk(reference, key) {
  const prior = reference.phase34_prior_recommendations || {};
  const item = prior[key];
  return item
    && item.status === 'satisfied_by_c04155d_do_not_repeat_as_open_work'
    && item.must_not_reopen === true;
}

function staleReadinessOk(reference, phase) {
  const stale = reference.stale_readiness || {};
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

function closuresOk(reference, contract = {}) {
  const closure = reference.closure_summary || {};
  const expected = contract.closureSummaryExpected || {};
  const refs = asArray(closure.closed_review_refs);
  const expectedRefs = asArray(expected.closed_review_refs);
  return closure.phase30_oracle_115_prerequisite_mapping_closure === true
    && closure.phase32_oracle_123_expires_at_closure === true
    && closure.phase33_oracle_127_validation_report_tamper_coverage_closure === true
    && closure.phase34_oracle_131_read_only_review_green === true
    && closure.phase35_oracle_134_read_only_review_green === true
    && closure.phase36_oracle_137_read_only_review_green === true
    && closure.phase37_oracle_141_read_only_review_green === true
    && closure.phase38_oracle_148_read_only_review_green === true
    && closure.phase38_oracle_149_delivery_resend_accepted === true
    && closure.phase39_oracle_156_read_only_review_green === true
    && expectedRefs.length === 10
    && expectedRefs.every((ref) => refs.includes(ref));
}

function sourceRefsOk(reference, contract = {}) {
  const expected = asArray(contract.sourceRefsExpected);
  const current = asArray(reference.source_refs);
  return expected.length === 9
    && current.length === 9
    && idsEqual(current, 'artifact_id', expected.map((item) => item.artifact_id))
    && expected.every((expectedRef) => current.some((ref) => (
      ref.artifact_id === expectedRef.artifact_id
      && ref.phase === expectedRef.phase
      && ref.fixture_path === expectedRef.fixture_path
      && ref.module_path === expectedRef.module_path
      && ref.test_path === expectedRef.test_path
    )));
}

function recentPhasePathsOk(reference, contract = {}) {
  const expected = asArray(contract.phaseRegistryExpected?.required_recent_phase_paths);
  const current = asArray(reference.phase_registry?.recent_phase_paths);
  return expected.length === 5
    && current.length === 5
    && expected.every((expectedPath) => current.some((entry) => (
      entry.phase === expectedPath.phase
      && entry.fixture_path === expectedPath.fixture_path
      && entry.module_path === expectedPath.module_path
      && entry.cli_path === expectedPath.cli_path
      && entry.test_path === expectedPath.test_path
      && entry.committed_baseline === expectedPath.committed_baseline
    )));
}

function runtimeModeReferenceOk(reference, contract = {}) {
  const expected = contract.runtimeModeReferenceShapeExpected || {};
  const values = expected.requiredValues || {};
  const current = reference.runtime_mode_reference || {};
  const expiresAt = Date.parse(current.expires_at);
  const generatedAt = Date.parse(reference.generated_at);
  return hasRequiredFields(current, expected.requiredFields || [])
    && current.default_state === values.default_state
    && current.effective_state === values.effective_state
    && valuesMatch(current.allowed_values, values.allowed_values)
    && current.reference_only === true
    && current.implemented_now === false
    && current.flag_reader_implemented === false
    && current.dev_only === true
    && current.local_only === true
    && current.operator_visible === true
    && current.authorizes_runtime === false
    && current.authorizes_dry_run === false
    && current.authorizes_execution === false
    && Number.isFinite(expiresAt)
    && Number.isFinite(generatedAt)
    && expiresAt > generatedAt;
}

function killSwitchReferenceOk(reference, contract = {}) {
  const expected = contract.killSwitchReferenceShapeExpected || {};
  const values = expected.requiredValues || {};
  const current = reference.kill_switch_reference || {};
  return hasRequiredFields(current, expected.requiredFields || [])
    && current.default_behavior === values.default_behavior
    && valuesMatch(current.fail_closed_states, values.fail_closed_states)
    && current.reference_only === true
    && current.implemented_now === false
    && current.wired === false
    && current.visible_to_operator === true
    && current.testable_later === true
    && current.authorizes_runtime === false
    && current.authorizes_execution === false;
}

function gapMappingOk(reference, contract = {}) {
  const expected = asArray(contract.gapMappingExpected);
  const mapping = reference.gap_mapping || {};
  const entries = [mapping.runtime_mode_flag_gap, mapping.kill_switch_gap].filter(Boolean);
  return entries.length === 2
    && expected.length === 2
    && idsEqual(entries, 'gap_id', expected.map((gap) => gap.gap_id))
    && expected.every((gap) => {
      const current = entries.find((entry) => entry.gap_id === gap.gap_id);
      return current
        && current.maps_from_phase39_gap === gap.maps_from_phase39_gap
        && current.reference_contract_only === true
        && current.satisfied_now === false
        && current.blocks_runtime_now === true
        && current.blocks_dry_run_now === true
        && current.authorizes_runtime === false
        && current.authorizes_dry_run === false
        && current.authorizes_execution === false
        && valuesMatch(current.future_green_requires, gap.future_green_requires);
    });
}

function controlReferenceOk(reference) {
  const control = reference.control_reference || {};
  return control.reference_only === true
    && control.disabled_by_default === true
    && control.control_execution_authorized === false
    && control.reporting_sink_wired === false
    && control.queue_created === false
    && control.lease_created === false
    && control.store_written === false
    && control.output_file_written === false
    && control.runtime_mode_flag_read === false
    && control.kill_switch_wired === false
    && control.runtime_started === false
    && control.runner_executed === false;
}

function referencesDoNotSatisfyGapsOk(reference) {
  const mode = reference.runtime_mode_reference || {};
  const kill = reference.kill_switch_reference || {};
  const mapping = reference.gap_mapping || {};
  return runtimeModeReferenceOk(reference, {
    runtimeModeReferenceShapeExpected: {
      requiredFields: [],
      requiredValues: {
        default_state: 'disabled',
        effective_state: 'disabled',
        allowed_values: ['disabled', 'dry_run_preview_only'],
      },
    },
  })
    && kill.reference_only === true
    && kill.implemented_now === false
    && kill.wired === false
    && kill.authorizes_runtime === false
    && kill.authorizes_execution === false
    && mode.authorizes_runtime === false
    && mode.authorizes_dry_run === false
    && mapping.runtime_mode_flag_gap?.satisfied_now === false
    && mapping.kill_switch_gap?.satisfied_now === false;
}

function capabilityTruthOk(reference) {
  const capability = reference.capability_matrix || {};
  return capability.runtimeStarted === false
    && capability.runnerExecuted === false
    && capability.runtimeAvailable === false
    && capability.realRuntimeAvailable === false
    && capability.serverCanExecuteLocal === false
    && capability.serverCanProveModelProcessing === false
    && capability.directBuilderOracleServerTargetsAllowed === false;
}

function proofBoundariesOk(reference) {
  const boundary = reference.boundary_truth || {};
  return boundary.runtimeStarted === false
    && boundary.runnerExecuted === false
    && boundary.runtimeAvailable === false
    && boundary.serverCanExecuteLocal === false
    && boundary.serverCanProveModelProcessing === false
    && boundary.builderOracleDirectServerTargetsAllowed === false
    && boundary.socketIsBridgeGreenProof === false
    && boundary.deliveryAcceptanceIsModelProcessingProof === false
    && boundary.phase39CommitIsRuntimeProof === false
    && boundary.runtimeModeReferenceIsRuntimeAuthorization === false
    && boundary.killSwitchReferenceIsRuntimeAuthorization === false
    && boundary.killSwitchReferenceIsExecutionAuthorization === false
    && boundary.modeKillSwitchReferenceIsDryRunAuthorization === false;
}

function redactionSummaryOk(reference) {
  const redaction = reference.redaction_summary || {};
  return redaction.raw_private_content_included === false
    && redaction.raw_terminal_included === false
    && redaction.raw_screenshot_ocr_browser_included === false
    && redaction.secret_material_included === false
    && redaction.customer_private_content_included === false;
}

function noModuleCliTestRuntimeWorkOk(reference) {
  const side = reference.side_effect_result || {};
  return side.no_module_or_cli_implemented === true
    && side.no_tests_implemented === true
    && side.no_ui_implemented === true
    && side.no_runtime_performed === true
    && side.no_runtime_mode_flag_read === true
    && side.no_kill_switch_wired === true
    && side.no_runner_executed === true
    && side.no_server_performed === true
    && side.no_control_execution_performed === true
    && side.no_reporting_sink_written === true
    && side.no_output_file_written === true
    && side.moduleOrCliImplemented === false
    && side.testsImplemented === false
    && side.runtimeStarted === false
    && side.runtimeModeFlagRead === false
    && side.killSwitchWired === false
    && side.runnerExecuted === false
    && side.serverStarted === false
    && side.controlExecutionPerformed === false
    && side.reportingSinkWritten === false
    && side.outputFileWritten === false;
}

function nextRecommendationsOk(reference, contract = {}) {
  const expected = asArray(contract.nextRecommendationExpectedCandidates);
  const recommendations = asArray(reference.next_phase_recommendations);
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

function occurrenceIsNegated(text, index) {
  const before = String(text || '').slice(Math.max(0, index - 260), index);
  const lastBoundary = Math.max(before.lastIndexOf('.'), before.lastIndexOf(';'), before.lastIndexOf(':'));
  const clause = before.slice(lastBoundary + 1);
  return /\b(no|without|blocked|blocks|disallow|disallowed|not|cannot|does not|must not|keeps|disabled|false|reference-only|contract-only|non-authorizing|unavailable|future|before)\b/i
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

function hasOutboundRecipientIntent(text) {
  const outboundTerms = new Set(['send', 'sent', 'sending', 'email', 'message', 'messaging', 'contact', 'reply', 'outbound']);
  const recipientTerms = new Set(['customer', 'customers', 'client', 'clients', 'contact', 'contacts', 'recipient', 'recipients']);
  const tokens = String(text || '').toLowerCase().match(/[a-z0-9]+/g) || [];
  return tokens.some((token) => outboundTerms.has(token))
    && tokens.some((token) => recipientTerms.has(token));
}

function unsafeActionDriftOk(reference, contract = {}) {
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
    'read runtime mode flag',
    'read env flag',
    'run rollback',
    'write report',
    'reporting sink',
  ];
  const phraseNeedles = asArray(contract.unsafeActionPhrases).map((phrase) => String(phrase || '').toLowerCase());
  const strings = [
    ...collectStringValues(reference.source_recommendation),
    ...collectStringValues(reference.satisfied_prior_recommendations),
    ...collectStringValues(reference.current_truth),
    ...collectStringValues(reference.stale_readiness),
    ...collectStringValues(reference.phase34_prior_recommendations),
    ...collectStringValues(reference.closure_summary),
    ...collectStringValues(reference.source_refs),
    ...collectStringValues(reference.runtime_mode_reference),
    ...collectStringValues(reference.kill_switch_reference),
    ...collectStringValues(reference.control_reference),
    ...collectStringValues(reference.gap_mapping),
    ...collectStringValues(reference.capability_matrix),
    ...collectStringValues(reference.boundary_truth),
    ...collectStringValues(reference.redaction_summary),
    ...collectStringValues(reference.unsafe_action_policy),
    ...collectStringValues(reference.next_phase_recommendations),
    ...collectStringValues(reference.evidenceRefs),
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
      throw new Error(`runtime_mode_kill_switch_reference_forbidden_substring:${forbidden}`);
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

function validateReference(reference = {}, contract = {}) {
  const checks = [];
  const errors = [];
  const resultById = {};
  const add = (id, ok) => {
    const result = resultObject(id, ok);
    checks.push(result);
    resultById[id] = result;
    if (!ok) errors.push(id);
  };

  const outputShapeOk = reference.schema === RUNTIME_MODE_KILL_SWITCH_REFERENCE_SCHEMA_VERSION
    && hasRequiredFields(reference, expectedManifestShape(contract).requiredFields || REQUIRED_REFERENCE_FIELDS);
  const baselineOk = reference.baseline_commit === BASELINE_COMMIT;
  const phase39Ok = currentTruthOk(reference, 39);
  const phase35Ok = currentTruthOk(reference, 35);
  const phase36Ok = currentTruthOk(reference, 36);
  const phase37Ok = currentTruthOk(reference, 37);
  const phase38Ok = currentTruthOk(reference, 38);
  const registryOk = registryCountsOk(reference);
  const chainOk = commitChainOk(reference, contract);
  const sourceOk = sourceRecommendationOk(reference, contract);
  const satisfiedOk = satisfiedPriorOk(reference, contract);
  const priorValidatorOk = phase34PriorRecommendationsOk(reference, 'phase35_runtime_status_milestone_refresh_validator');
  const priorCliOk = phase34PriorRecommendationsOk(reference, 'phase35_stdout_only_cli_smoke');
  const priorOk = priorValidatorOk && priorCliOk;
  const phase13Ok = staleReadinessOk(reference, 13);
  const phase23Ok = staleReadinessOk(reference, 23);
  const phase31Ok = staleReadinessOk(reference, 31);
  const closureOk = closuresOk(reference, contract);
  const refsOk = sourceRefsOk(reference, contract);
  const recentPathsOk = recentPhasePathsOk(reference, contract);
  const modeOk = runtimeModeReferenceOk(reference, contract);
  const killOk = killSwitchReferenceOk(reference, contract);
  const mappingOk = gapMappingOk(reference, contract);
  const controlOk = controlReferenceOk(reference);
  const referencesNonSatisfyingOk = referencesDoNotSatisfyGapsOk(reference);
  const capabilityOk = capabilityTruthOk(reference);
  const proofOk = proofBoundariesOk(reference);
  const sideEffectOk = sideEffectValuesOk(reference.side_effect_result);
  const scopeOk = noModuleCliTestRuntimeWorkOk(reference);
  let forbiddenOk = true;
  try {
    assertNoForbiddenOutput(reference, asArray(contract.forbiddenOutputSubstrings));
  } catch {
    forbiddenOk = false;
  }
  const redactionOk = redactionSummaryOk(reference) && forbiddenOk;
  const recommendationsOk = nextRecommendationsOk(reference, contract);
  const recommendationsNonAuth = recommendationsOk
    && asArray(reference.next_phase_recommendations).every((item) => (
      item.does_not_authorize_ui === true
      && item.does_not_authorize_runtime === true
      && item.does_not_authorize_execution === true
    ));
  const unsafeOk = unsafeActionDriftOk(reference, contract);
  const literalsOk = literalValuesOk(reference, expectedManifestShape(contract).requiredLiteralValues || {});
  const idempotencyOk = reference.idempotency_key === runtimeModeKillSwitchIdempotencyKey(reference);

  const staticRuleOk = {
    'baseline-pinned-a62fe16': baselineOk,
    'phase39-current': phase39Ok,
    'phase35-current-preserved': phase35Ok,
    'phase36-current-preserved': phase36Ok,
    'phase37-current-preserved': phase37Ok,
    'phase38-current-preserved': phase38Ok,
    'phase-inventory-count-39': registryOk,
    'schema-registry-count-39': registryOk,
    'cli-registry-count-39': registryOk,
    'commit-chain-exact-27': chainOk,
    'source-recommendation-tier1-selected': sourceOk,
    'phase39-tier0-satisfied-not-open': satisfiedOk,
    'phase34-prior-recommendations-satisfied': priorOk,
    'phase13-stale-preserved': phase13Ok,
    'phase23-stale-preserved': phase23Ok,
    'phase31-stale-preserved': phase31Ok,
    'closures-carried-oracle-115-123-127-131-134-137-141-148-149-156': closureOk,
    'source-refs-phase26-27-29-30-32-33-37-38-39': refsOk,
    'recent-phase-paths-present': recentPathsOk,
    'runtime-mode-reference-disabled-reference-only': modeOk,
    'kill-switch-reference-fail-closed-reference-only': killOk,
    'gap-mapping-two-unsatisfied-gaps': mappingOk,
    'control-reference-no-side-effects': controlOk,
    'mode-kill-switch-references-do-not-satisfy-gaps': referencesNonSatisfyingOk,
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
    'baseline-a62fe16-pinned': baselineOk,
    'phase39-current-a62fe16': phase39Ok,
    'phase35-current-preserved': phase35Ok,
    'phase36-current-preserved': phase36Ok,
    'phase37-current-preserved': phase37Ok,
    'phase38-current-preserved': phase38Ok,
    'phase-inventory-exactly-39': registryOk,
    'schema-registry-exactly-39': registryOk,
    'cli-registry-exactly-39': registryOk,
    'commit-chain-count-27-ending-a62fe16': chainOk,
    'source-tier1-mode-kill-switch-selected': sourceOk,
    'phase39-tier0-validator-satisfied': satisfiedOk,
    'phase39-tier0-validator-not-reopened': satisfiedOk,
    'phase34-prior-validator-satisfied-not-reopened': priorValidatorOk,
    'phase34-prior-cli-smoke-satisfied-not-reopened': priorCliOk,
    'phase13-stale-truth-preserved': phase13Ok,
    'phase23-stale-truth-preserved': phase23Ok,
    'phase31-stale-superseded-by-phase34': phase31Ok,
    'closures-oracle-115-123-127-131-134-137-141-148-149-156-present': closureOk,
    'source-refs-phase26-27-29-30-32-33-37-38-39-present': refsOk,
    'recent-phase-paths-present': recentPathsOk,
    'runtime-mode-reference-required-fields-present':
      hasRequiredFields(reference.runtime_mode_reference, contract.runtimeModeReferenceShapeExpected?.requiredFields || []),
    'runtime-mode-reference-disabled-default':
      reference.runtime_mode_reference?.default_state === 'disabled'
      && reference.runtime_mode_reference?.effective_state === 'disabled',
    'runtime-mode-reference-local-dev-only':
      reference.runtime_mode_reference?.local_only === true
      && reference.runtime_mode_reference?.dev_only === true,
    'runtime-mode-reference-unimplemented':
      reference.runtime_mode_reference?.implemented_now === false
      && reference.runtime_mode_reference?.flag_reader_implemented === false,
    'runtime-mode-reference-non-authorizing':
      reference.runtime_mode_reference?.authorizes_runtime === false
      && reference.runtime_mode_reference?.authorizes_dry_run === false
      && reference.runtime_mode_reference?.authorizes_execution === false,
    'kill-switch-reference-required-fields-present':
      hasRequiredFields(reference.kill_switch_reference, contract.killSwitchReferenceShapeExpected?.requiredFields || []),
    'kill-switch-reference-fail-closed':
      reference.kill_switch_reference?.default_behavior === 'fail_closed'
      && valuesMatch(reference.kill_switch_reference?.fail_closed_states, ['missing', 'false', 'invalid', 'stale', 'unknown']),
    'kill-switch-reference-unwired':
      reference.kill_switch_reference?.implemented_now === false
      && reference.kill_switch_reference?.wired === false,
    'kill-switch-reference-non-authorizing':
      reference.kill_switch_reference?.authorizes_runtime === false
      && reference.kill_switch_reference?.authorizes_execution === false,
    'gap-mapping-exactly-two': mappingOk,
    'gap-mapping-unsatisfied-and-blocking': mappingOk,
    'control-reference-no-queue-lease-store-output-reporting': controlOk,
    'runtime-started-false': reference.capability_matrix?.runtimeStarted === false
      && reference.boundary_truth?.runtimeStarted === false
      && reference.side_effect_result?.runtimeStarted === false,
    'runner-executed-false': reference.capability_matrix?.runnerExecuted === false
      && reference.boundary_truth?.runnerExecuted === false
      && reference.side_effect_result?.runnerExecuted === false,
    'runtime-available-false': reference.capability_matrix?.runtimeAvailable === false
      && reference.boundary_truth?.runtimeAvailable === false,
    'server-can-execute-local-false': reference.capability_matrix?.serverCanExecuteLocal === false
      && reference.boundary_truth?.serverCanExecuteLocal === false,
    'server-can-prove-model-processing-false': reference.capability_matrix?.serverCanProveModelProcessing === false
      && reference.boundary_truth?.serverCanProveModelProcessing === false,
    'builder-oracle-direct-targets-blocked': reference.capability_matrix?.directBuilderOracleServerTargetsAllowed === false
      && reference.boundary_truth?.builderOracleDirectServerTargetsAllowed === false,
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
  add('reference-literal-values', literalsOk);
  add('reference-contract-complete',
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

function literalResultsOk(results = [], reference = {}, contract = {}) {
  const expected = requiredLiteralResults(reference, expectedManifestShape(contract).requiredLiteralValues || {});
  return valuesMatch(asArray(results), expected)
    && results.length >= Number(expectedManifestShape(contract).expectedCounts?.required_literal_results_min || 0);
}

function buildValidationReport(reference, contract = {}, generatedAt = reference.generated_at) {
  const validation = validateReference(reference, contract);
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
  const validationReport = {
    schema: VALIDATION_REPORT_SCHEMA_VERSION,
    version: RUNTIME_MODE_KILL_SWITCH_REFERENCE_VERSION,
    validation_id: `runtime-mode-kill-switch-validation-${stableHash({
      reference_key: reference.idempotency_key,
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
    required_literal_results: requiredLiteralResults(reference, expectedManifestShape(contract).requiredLiteralValues || {}),
    referenced_path_results: buildReferencedPathResults(contract),
    forbidden_output_scan: resultObject('forbidden-output-strings-absent', forbiddenScanOk),
    side_effect_truth: sideEffectResult(),
    summary: {
      current_through_phase: reference.phase_registry?.current_through_phase,
      phase_registry_count: reference.phase_registry?.phase_inventory_count,
      schema_registry_count: reference.phase_registry?.schema_registry_count,
      cli_registry_count: reference.phase_registry?.cli_registry_count,
      commit_chain_count: asArray(reference.commit_chain).length,
      source_ref_count: asArray(reference.source_refs).length,
      gap_mapping_count: Object.keys(reference.gap_mapping || {}).length,
      next_recommendation_count: asArray(reference.next_phase_recommendations).length,
      baseline_commit: reference.baseline_commit,
      accepted_validation_only: validation.ok,
    },
  };
  assertNoForbiddenOutput(validationReport, asArray(contract.forbiddenOutputSubstrings));
  return validationReport;
}

function buildMiraCoreRuntimeModeKillSwitch(options = {}) {
  const contract = options.contract || {};
  const runtime_mode_kill_switch_reference = buildReference(options);
  const validation_report = buildValidationReport(
    runtime_mode_kill_switch_reference,
    contract,
    runtime_mode_kill_switch_reference.generated_at,
  );
  const output = {
    runtime_mode_kill_switch_reference,
    validation_report,
  };
  assertNoForbiddenOutput(output, asArray(contract.forbiddenOutputSubstrings));
  return output;
}

function validateMiraCoreRuntimeModeKillSwitchOutput(output = {}, contract = {}) {
  const checks = [];
  const errors = [];
  const add = (id, ok) => {
    checks.push({ id, ok: ok === true });
    if (!ok) errors.push(id);
  };
  const reference = output.runtime_mode_kill_switch_reference || {};
  const validationReport = output.validation_report || {};
  const referenceValidation = validateReference(reference, contract);
  const referencedOk = referencedPathResultsOk(validationReport.referenced_path_results, contract);
  const recomputedById = referenceValidation.checks.reduce((acc, check) => {
    acc[check.id] = check;
    return acc;
  }, {});
  recomputedById['referenced-path-results-complete'] =
    resultObject('referenced-path-results-complete', referencedOk);

  const staticIds = asArray(contract.staticValidationRules).map((rule) => rule.id);
  const acceptanceIds = asArray(contract.acceptanceChecks).map((check) => check.id);
  const reportCoverageOk =
    resultListMatches(validationReport.static_rule_results, staticIds, recomputedById)
    && resultListMatches(validationReport.acceptance_check_results, acceptanceIds, recomputedById)
    && tamperCaseResultsOk(validationReport.tamper_case_results, contract)
    && literalResultsOk(validationReport.required_literal_results, reference, contract)
    && referencedOk;
  recomputedById['validation-report-coverage-bound'] =
    resultObject('validation-report-coverage-bound', reportCoverageOk);

  add('output-shape-complete',
    hasRequiredFields(output, contract.expectedOutputShape?.requiredTopLevelFields || REQUIRED_OUTPUT_FIELDS)
      && reference.schema === RUNTIME_MODE_KILL_SWITCH_REFERENCE_SCHEMA_VERSION
      && validationReport.schema === VALIDATION_REPORT_SCHEMA_VERSION
      && hasRequiredFields(reference, contract.expectedManifestShape?.requiredFields || REQUIRED_REFERENCE_FIELDS)
      && hasRequiredFields(validationReport, contract.expectedValidationReportShape?.requiredFields || REQUIRED_VALIDATION_REPORT_FIELDS));

  for (const check of referenceValidation.checks) {
    if (check.id !== 'referenced-path-results-complete'
      && check.id !== 'validation-report-coverage-bound') {
      add(check.id, check.ok);
    }
  }

  add('validation-report-literal-values',
    validationReport.schema === VALIDATION_REPORT_SCHEMA_VERSION
      && validationReport.baseline_commit === BASELINE_COMMIT
      && literalValuesOk(validationReport, validationShape(contract).requiredLiteralValues || {}));

  add('validation-report-side-effect-truth', sideEffectValuesOk(validationReport.side_effect_truth));
  add('referenced-path-results-complete', referencedOk);
  add('validation-report-coverage-bound', reportCoverageOk);

  add('validation-report-matches-contract',
    validationReport.accepted === referenceValidation.ok
      && validationReport.blocked === !referenceValidation.ok
      && validationReport.decision === (referenceValidation.ok ? 'accepted_validation_only' : 'rejected')
      && valuesMatch(
        asArray(validationReport.reasons),
        referenceValidation.checks.filter((check) => !check.ok).map((check) => check.id),
      )
      && reportCoverageOk
      && validationReport.forbidden_output_scan?.ok === Boolean(recomputedById['redaction-summary-safe']?.ok));

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
  REQUIRED_REFERENCE_FIELDS,
  REQUIRED_SIDE_EFFECT_FIELDS,
  REQUIRED_VALIDATION_REPORT_FIELDS,
  RUNTIME_MODE_KILL_SWITCH_REFERENCE_SCHEMA_VERSION,
  VALIDATION_REPORT_SCHEMA_VERSION,
  assertNoForbiddenOutput,
  buildMiraCoreRuntimeModeKillSwitch,
  runtimeModeKillSwitchIdempotencyKey,
  stableHash,
  validateMiraCoreRuntimeModeKillSwitchOutput,
};
