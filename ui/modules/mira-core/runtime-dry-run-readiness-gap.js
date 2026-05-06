'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const RUNTIME_DRY_RUN_READINESS_GAP_SCHEMA_VERSION =
  'squidrun.mira_core.runtime_dry_run_readiness_gap.v0';
const VALIDATION_REPORT_SCHEMA_VERSION =
  'squidrun.mira_core.runtime_dry_run_readiness_gap_validation_report.v0';
const RUNTIME_DRY_RUN_READINESS_GAP_VERSION = 'v0';
const BASELINE_COMMIT = '85c78ab';
const FIXTURE_REF =
  'ui/__tests__/fixtures/mira-core-runtime-dry-run-readiness-gap-contract.json';

const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');

const REQUIRED_OUTPUT_FIELDS = Object.freeze([
  'runtime_dry_run_readiness_gap',
  'validation_report',
]);

const REQUIRED_GAP_REPORT_FIELDS = Object.freeze([
  'schema',
  'version',
  'gap_report_id',
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
  'gap_summary',
  'readiness_gap_matrix',
  'dry_run_boundary',
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
  'dry run available now',
  'dry run authorized',
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
  'phase38 commit proves runtime',
  'readiness gap authorizes runtime',
  'readiness gap authorizes dry run',
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
  'phase38 commit proves runtime',
  'readiness gap authorizes runtime',
  'readiness gap authorizes dry run',
  'socket proves bridge green',
  'delivery acceptance proves model processing',
  'builder direct target allowed',
  'oracle direct target allowed',
]));

const GAP_BLOCKER_STATUS = 'defined_not_satisfied';

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

function evidenceRef(store, eventId, relation = 'runtime_dry_run_readiness_gap_validation') {
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
    sessionId: inputSignals.sessionId || 'session-329',
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
    current_through_phase: 38,
    expected_phases: expected.expected_phases || '1-38',
    phase_inventory_count: 38,
    schema_registry_count: 38,
    cli_registry_count: 38,
    phase35_runtime_next_action_current: true,
    phase36_operator_ui_surface_current: true,
    phase37_control_reporting_reconciliation_current: true,
    phase38_runtime_readiness_refresh_current: true,
    phase38_commit: BASELINE_COMMIT,
    phase38_delta: clone(expected.phase38_delta || {}),
    recent_phase_paths: clone(expected.required_recent_phase_paths || []),
    evidenceRefs: [
      evidenceRef('git', BASELINE_COMMIT, 'phase39-baseline'),
      evidenceRef('mira-core-runtime-dry-run-readiness-gap-contract', 'phase-registry'),
    ],
  };
}

function registryEntries(kind, contract = {}) {
  const recent = new Map(asArray(contract.phaseRegistryExpected?.required_recent_phase_paths)
    .map((entry) => [entry.phase, entry]));
  return Array.from({ length: 38 }, (_, index) => {
    const phase = index + 1;
    const recentEntry = recent.get(phase);
    return {
      phase,
      registry_kind: kind,
      artifact_id: recentEntry ? `phase${phase}-${kind}` : `phase${phase}-${kind}-registered`,
      status: phase <= 38 ? 'registered_validation_artifact' : 'unknown',
      ...(recentEntry ? clone(recentEntry) : {}),
    };
  });
}

function currentTruth() {
  return {
    phase35_current: true,
    phase36_current: true,
    phase37_current: true,
    phase38_current: true,
    evidenceRefs: [
      evidenceRef('git', '801a92a', 'phase35-current'),
      evidenceRef('git', '6f08b05', 'phase36-current'),
      evidenceRef('git', 'c8b55be', 'phase37-current'),
      evidenceRef('git', BASELINE_COMMIT, 'phase38-current'),
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

function closureSummary(contract = {}) {
  const expected = contract.closureSummaryExpected || {};
  return {
    closed_review_refs: clone(expected.closed_review_refs || []),
    phase30_oracle_115_prerequisite_mapping_closure:
      expected.phase30_oracle_115_prerequisite_mapping_closure === true,
    phase32_oracle_123_expires_at_closure:
      expected.phase32_oracle_123_expires_at_closure === true,
    phase33_oracle_127_validation_report_tamper_coverage_closure:
      expected.phase33_oracle_127_validation_report_tamper_coverage_closure === true,
    phase34_oracle_131_read_only_review_green:
      expected.phase34_oracle_131_read_only_review_green === true,
    phase35_oracle_134_read_only_review_green:
      expected.phase35_oracle_134_read_only_review_green === true,
    phase36_oracle_137_read_only_review_green:
      expected.phase36_oracle_137_read_only_review_green === true,
    phase37_oracle_141_read_only_review_green:
      expected.phase37_oracle_141_read_only_review_green === true,
    phase38_oracle_148_read_only_review_green:
      expected.phase38_oracle_148_read_only_review_green === true,
    phase38_oracle_149_delivery_resend_accepted:
      expected.phase38_oracle_149_delivery_resend_accepted === true,
    evidenceRefs: asArray(expected.closed_review_refs).map((ref) => (
      evidenceRef('oracle-review', ref, 'closure-carried')
    )),
  };
}

function readinessGapMatrix(contract = {}) {
  const shape = contract.readinessGapShapeExpected || {};
  const required = shape.requiredGapValues || {};
  return asArray(shape.gapMapExpected).map((gap) => ({
    gap_id: gap.gap_id,
    maps_from_prior_prerequisite: gap.maps_from_prior_prerequisite,
    current_status: required.current_status || GAP_BLOCKER_STATUS,
    required_before_dry_run: required.required_before_dry_run === true,
    blocks_runtime_now: required.blocks_runtime_now === true,
    blocks_dry_run_now: required.blocks_dry_run_now === true,
    satisfied_now: false,
    authorizes_runtime: false,
    authorizes_dry_run: false,
    authorizes_execution: false,
    non_authorizing: true,
    evidence_required: gap.evidence_required,
    source_refs: ['phase29-runtime-dry-run-implementation', 'phase37-runtime-control-reporting-reconciliation'],
    evidenceRefs: [evidenceRef('mira-core-runtime-dry-run-readiness-gap-contract', gap.gap_id)],
  }));
}

function gapSummary(gaps = []) {
  return {
    decision: 'remain_gap_contract_only',
    gap_count: gaps.length,
    all_gaps_block_runtime_now: gaps.every((gap) => gap.blocks_runtime_now === true),
    all_gaps_block_dry_run_now: gaps.every((gap) => gap.blocks_dry_run_now === true),
    all_gaps_non_authorizing: gaps.every((gap) => gap.non_authorizing === true),
    runtime_authorized_now: false,
    dry_run_authorized_now: false,
    runner_execution_authorized_now: false,
    blocking_gap_ids: gaps.map((gap) => gap.gap_id),
    evidenceRefs: [evidenceRef('mira-core-runtime-dry-run-readiness-gap-contract', 'gap-summary')],
  };
}

function dryRunBoundary() {
  return {
    disabled_local_dry_run_available_now: false,
    disabled_by_default: true,
    local_only: true,
    dev_only: true,
    in_process_or_loopback_only: true,
    runtime_mode_flag_implemented: false,
    kill_switch_wired: false,
    tested_dry_run_runtime_path: false,
    queue_or_lease_created: false,
    store_or_output_written: false,
    reporting_sink_written: false,
    authorizes_runtime: false,
    authorizes_dry_run: false,
    authorizes_execution: false,
    evidenceRefs: [evidenceRef('mira-core-runtime-dry-run-readiness-gap-contract', 'dry-run-boundary')],
  };
}

function capabilityMatrix(contract = {}) {
  return {
    ...clone(contract.capabilityMatrixExpected || {}),
    evidenceRefs: [evidenceRef('mira-core-runtime-dry-run-readiness-gap-contract', 'capability-matrix')],
  };
}

function boundaryTruth(contract = {}) {
  return {
    ...clone(contract.boundaryTruthExpected || {}),
    evidenceRefs: [evidenceRef('mira-core-runtime-dry-run-readiness-gap-contract', 'boundary-truth')],
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
    evidenceRefs: [evidenceRef('mira-core-runtime-dry-run-readiness-gap-contract', 'redaction-summary')],
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
    control_execution_allowed: false,
    reporting_sink_allowed: false,
    unsafe_action_drift_rejected: true,
    evidenceRefs: [evidenceRef('mira-core-runtime-dry-run-readiness-gap-contract', 'unsafe-action-policy')],
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
      'irreversible-action-boundary',
    ],
    evidenceRefs: [
      evidenceRef('mira-core-runtime-dry-run-readiness-gap-contract', `next:${candidate.recommendation_id}`),
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

function canonicalGapReportInput(report = {}) {
  return {
    profile: report.profile,
    sessionId: report.sessionId,
    deviceId: report.deviceId,
    baseline_commit: report.baseline_commit,
    phase_registry: report.phase_registry,
    schema_registry: report.schema_registry,
    cli_registry: report.cli_registry,
    commit_chain: report.commit_chain,
    source_recommendation: report.source_recommendation,
    satisfied_prior_recommendations: report.satisfied_prior_recommendations,
    current_truth: report.current_truth,
    stale_readiness: report.stale_readiness,
    phase34_prior_recommendations: report.phase34_prior_recommendations,
    closure_summary: report.closure_summary,
    source_refs: report.source_refs,
    gap_summary: report.gap_summary,
    readiness_gap_matrix: report.readiness_gap_matrix,
    dry_run_boundary: report.dry_run_boundary,
    capability_matrix: report.capability_matrix,
    boundary_truth: report.boundary_truth,
    redaction_summary: report.redaction_summary,
    unsafe_action_policy: report.unsafe_action_policy,
    next_phase_recommendations: report.next_phase_recommendations,
    side_effect_result: report.side_effect_result,
  };
}

function runtimeDryRunReadinessGapIdempotencyKey(report) {
  return `runtime-dry-run-readiness-gap:${stableHash(canonicalGapReportInput(report))}`;
}

function buildGapReport(options = {}) {
  const contract = options.contract || {};
  const inputSignals = options.inputSignals || {};
  const scope = normalizeScope(inputSignals);
  const generatedAt = generatedAtFromOptions(options, inputSignals);
  const gaps = readinessGapMatrix(contract);
  const report = {
    schema: RUNTIME_DRY_RUN_READINESS_GAP_SCHEMA_VERSION,
    version: RUNTIME_DRY_RUN_READINESS_GAP_VERSION,
    gap_report_id: null,
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
      evidenceRefs: [evidenceRef('mira-core-runtime-readiness-refresh-through-phase37', 'source-recommendation')],
    },
    satisfied_prior_recommendations: clone(contract.satisfiedPriorRecommendations || []),
    current_truth: currentTruth(),
    stale_readiness: staleReadiness(contract),
    phase34_prior_recommendations: phase34PriorRecommendations(contract),
    closure_summary: closureSummary(contract),
    source_refs: clone(contract.sourceRefsExpected || []),
    gap_summary: gapSummary(gaps),
    readiness_gap_matrix: gaps,
    dry_run_boundary: dryRunBoundary(),
    capability_matrix: capabilityMatrix(contract),
    boundary_truth: boundaryTruth(contract),
    redaction_summary: redactionSummary(),
    unsafe_action_policy: unsafeActionPolicy(),
    next_phase_recommendations: nextPhaseRecommendations(contract),
    evidenceRefs: [
      evidenceRef('git', BASELINE_COMMIT, 'phase39-baseline'),
      evidenceRef('mira-core-runtime-dry-run-readiness-gap-contract', 'phase39-contract'),
    ],
    side_effect_result: sideEffectResult(),
  };
  report.idempotency_key = runtimeDryRunReadinessGapIdempotencyKey(report);
  report.gap_report_id = `runtime-dry-run-readiness-gap-${stableHash({
    key: report.idempotency_key,
  }).slice(0, 12)}`;
  assertNoForbiddenOutput(report, asArray(contract.forbiddenOutputSubstrings));
  return report;
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

function phase38CurrentOk(report) {
  const registry = report.phase_registry || {};
  const delta = registry.phase38_delta || {};
  return registry.current_through_phase === 38
    && registry.phase38_runtime_readiness_refresh_current === true
    && registry.phase38_commit === BASELINE_COMMIT
    && delta.phase === 38
    && delta.name === 'runtime-readiness-refresh-through-phase37'
    && delta.committed_baseline === BASELINE_COMMIT
    && delta.status === 'local_validation_runtime_readiness_refresh_current'
    && delta.validation_only === true
    && delta.capability_truth?.runtimeStarted === false
    && delta.capability_truth?.runnerExecuted === false
    && delta.capability_truth?.runtimeAvailable === false
    && delta.capability_truth?.serverCanExecuteLocal === false
    && delta.capability_truth?.serverCanProveModelProcessing === false
    && delta.capability_truth?.directBuilderOracleServerTargetsAllowed === false;
}

function currentTruthOk(report, phase) {
  const truth = report.current_truth || {};
  if (phase === 35) return truth.phase35_current === true && report.phase_registry?.phase35_runtime_next_action_current === true;
  if (phase === 36) return truth.phase36_current === true && report.phase_registry?.phase36_operator_ui_surface_current === true;
  if (phase === 37) return truth.phase37_current === true && report.phase_registry?.phase37_control_reporting_reconciliation_current === true;
  if (phase === 38) return truth.phase38_current === true && phase38CurrentOk(report);
  return false;
}

function registryCountsOk(report) {
  const registry = report.phase_registry || {};
  return registry.phase_inventory_count === 38
    && registry.schema_registry_count === 38
    && registry.cli_registry_count === 38
    && registry.current_through_phase === 38
    && asArray(report.schema_registry).length === 38
    && asArray(report.cli_registry).length === 38;
}

function commitChainOk(report, contract = {}) {
  const expected = asArray(contract.commitChainExpected);
  const chain = asArray(report.commit_chain);
  return expected.length === 26
    && chain.length === 26
    && valuesMatch(chain, expected)
    && chain[chain.length - 1] === BASELINE_COMMIT;
}

function sourceRecommendationOk(report, contract = {}) {
  const expected = contract.sourceRecommendation || {};
  const current = report.source_recommendation || {};
  return current.recommendation_id === expected.recommendation_id
    && current.tier === 'tier1'
    && current.status === expected.status
    && current.contract_only_now === true
    && current.implemented_now === false
    && current.does_not_authorize_ui === true
    && current.does_not_authorize_runtime === true
    && current.does_not_authorize_execution === true;
}

function satisfiedPriorOk(report, contract = {}) {
  const expected = asArray(contract.satisfiedPriorRecommendations);
  const current = asArray(report.satisfied_prior_recommendations);
  return expected.length === 1
    && current.length === 1
    && current[0].recommendation_id === expected[0].recommendation_id
    && current[0].satisfied_by_commit === BASELINE_COMMIT
    && current[0].status === 'satisfied_by_85c78ab_do_not_repeat_as_open_work'
    && current[0].must_not_reopen === true
    && valuesMatch(current[0].satisfied_by_files, expected[0].satisfied_by_files)
    && !asArray(report.next_phase_recommendations).some((item) => (
      item.recommendation_id === current[0].recommendation_id
    ));
}

function phase34PriorRecommendationsOk(report, key) {
  const prior = report.phase34_prior_recommendations || {};
  const item = prior[key];
  return item
    && item.status === 'satisfied_by_c04155d_do_not_repeat_as_open_work'
    && item.satisfied_by_commit === 'c04155d'
    && item.must_not_reopen === true;
}

function staleReadinessOk(report, phase) {
  const stale = report.stale_readiness || {};
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

function closuresOk(report, contract = {}) {
  const closure = report.closure_summary || {};
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
    && expectedRefs.length === 9
    && expectedRefs.every((ref) => refs.includes(ref));
}

function sourceRefsOk(report, contract = {}) {
  const expected = asArray(contract.sourceRefsExpected);
  const current = asArray(report.source_refs);
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

function recentPhasePathsOk(report, contract = {}) {
  const expected = asArray(contract.phaseRegistryExpected?.required_recent_phase_paths);
  const current = asArray(report.phase_registry?.recent_phase_paths);
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

function readinessGapMatrixOk(report, contract = {}) {
  const shape = contract.readinessGapShapeExpected || {};
  const expectedIds = asArray(shape.requiredGapIds);
  const gaps = asArray(report.readiness_gap_matrix);
  const requiredFields = asArray(shape.gapRequiredFields);
  const expectedMap = new Map(asArray(shape.gapMapExpected).map((gap) => [gap.gap_id, gap]));
  return expectedIds.length === 9
    && gaps.length === 9
    && idsEqual(gaps, 'gap_id', expectedIds)
    && gaps.every((gap) => {
      const expected = expectedMap.get(gap.gap_id);
      return hasRequiredFields(gap, requiredFields)
        && expected
        && gap.maps_from_prior_prerequisite === expected.maps_from_prior_prerequisite
        && gap.evidence_required === expected.evidence_required
        && gap.current_status === GAP_BLOCKER_STATUS
        && gap.required_before_dry_run === true
        && gap.blocks_runtime_now === true
        && gap.blocks_dry_run_now === true
        && gap.satisfied_now === false
        && gap.authorizes_runtime === false
        && gap.authorizes_dry_run === false
        && gap.authorizes_execution === false
        && gap.non_authorizing === true
        && asArray(gap.source_refs).length > 0;
    });
}

function gapSummaryOk(report) {
  const summary = report.gap_summary || {};
  const gaps = asArray(report.readiness_gap_matrix);
  return summary.decision === 'remain_gap_contract_only'
    && summary.gap_count === 9
    && summary.all_gaps_block_runtime_now === true
    && summary.all_gaps_block_dry_run_now === true
    && summary.all_gaps_non_authorizing === true
    && summary.runtime_authorized_now === false
    && summary.dry_run_authorized_now === false
    && summary.runner_execution_authorized_now === false
    && valuesMatch(summary.blocking_gap_ids, gaps.map((gap) => gap.gap_id));
}

function gapsUnsatisfiedOk(report) {
  return asArray(report.readiness_gap_matrix).length === 9
    && asArray(report.readiness_gap_matrix).every((gap) => gap.satisfied_now === false);
}

function gapsBlockRuntimeOk(report) {
  return asArray(report.readiness_gap_matrix).length === 9
    && asArray(report.readiness_gap_matrix).every((gap) => gap.blocks_runtime_now === true)
    && report.gap_summary?.all_gaps_block_runtime_now === true;
}

function gapsBlockDryRunOk(report) {
  return asArray(report.readiness_gap_matrix).length === 9
    && asArray(report.readiness_gap_matrix).every((gap) => gap.blocks_dry_run_now === true)
    && report.gap_summary?.all_gaps_block_dry_run_now === true;
}

function gapsNonAuthorizingOk(report) {
  return asArray(report.readiness_gap_matrix).length === 9
    && asArray(report.readiness_gap_matrix).every((gap) => (
      gap.authorizes_runtime === false
      && gap.authorizes_dry_run === false
      && gap.authorizes_execution === false
      && gap.non_authorizing === true
    ))
    && report.gap_summary?.all_gaps_non_authorizing === true
    && report.gap_summary?.runtime_authorized_now === false
    && report.gap_summary?.dry_run_authorized_now === false;
}

function dryRunBoundaryOk(report) {
  const boundary = report.dry_run_boundary || {};
  return boundary.disabled_local_dry_run_available_now === false
    && boundary.disabled_by_default === true
    && boundary.local_only === true
    && boundary.dev_only === true
    && boundary.in_process_or_loopback_only === true
    && boundary.runtime_mode_flag_implemented === false
    && boundary.kill_switch_wired === false
    && boundary.tested_dry_run_runtime_path === false
    && boundary.queue_or_lease_created === false
    && boundary.store_or_output_written === false
    && boundary.reporting_sink_written === false
    && boundary.authorizes_runtime === false
    && boundary.authorizes_dry_run === false
    && boundary.authorizes_execution === false;
}

function dryRunGapsDoNotAuthorizeRuntimeOk(report) {
  const side = report.side_effect_result || {};
  return gapsNonAuthorizingOk(report)
    && report.boundary_truth?.readinessGapIsRuntimeAuthorization === false
    && report.boundary_truth?.readinessGapIsDryRunAuthorization === false
    && report.boundary_truth?.controlReportIsExecutionAuthorization === false
    && report.dry_run_boundary?.queue_or_lease_created === false
    && report.dry_run_boundary?.store_or_output_written === false
    && report.dry_run_boundary?.reporting_sink_written === false
    && side.queueCreated === false
    && side.leaseCreated === false
    && side.storeWritePerformed === false
    && side.reportingSinkWritten === false
    && side.outputFileWritten === false;
}

function capabilityTruthOk(report) {
  const capability = report.capability_matrix || {};
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

function proofBoundariesOk(report) {
  const boundary = report.boundary_truth || {};
  return boundary.runtimeStarted === false
    && boundary.runnerExecuted === false
    && boundary.runtimeAvailable === false
    && boundary.serverCanExecuteLocal === false
    && boundary.serverCanProveModelProcessing === false
    && boundary.builderOracleDirectServerTargetsAllowed === false
    && boundary.socketIsBridgeGreenProof === false
    && boundary.deliveryAcceptanceIsModelProcessingProof === false
    && boundary.phase38CommitIsRuntimeProof === false
    && boundary.readinessGapIsRuntimeAuthorization === false
    && boundary.readinessGapIsDryRunAuthorization === false
    && boundary.controlReportIsExecutionAuthorization === false
    && boundary.operatorSurfaceIsUiProof === false;
}

function redactionSummaryOk(report) {
  const redaction = report.redaction_summary || {};
  return redaction.raw_private_content_included === false
    && redaction.raw_terminal_included === false
    && redaction.raw_screenshot_ocr_browser_included === false
    && redaction.secret_material_included === false
    && redaction.customer_private_content_included === false;
}

function noModuleCliTestRuntimeWorkOk(report) {
  const side = report.side_effect_result || {};
  return side.no_module_or_cli_implemented === true
    && side.no_tests_implemented === true
    && side.no_ui_implemented === true
    && side.no_runtime_performed === true
    && side.no_runner_executed === true
    && side.no_server_performed === true
    && side.no_control_execution_performed === true
    && side.no_reporting_sink_written === true
    && side.no_output_file_written === true
    && side.moduleOrCliImplemented === false
    && side.testsImplemented === false
    && side.runtimeStarted === false
    && side.runnerExecuted === false
    && side.serverStarted === false
    && side.controlExecutionPerformed === false
    && side.reportingSinkWritten === false
    && side.outputFileWritten === false;
}

function nextRecommendationsOk(report, contract = {}) {
  const expected = asArray(contract.nextRecommendationExpectedCandidates);
  const recommendations = asArray(report.next_phase_recommendations);
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
  const before = String(text || '').slice(Math.max(0, index - 240), index);
  const lastBoundary = Math.max(before.lastIndexOf('.'), before.lastIndexOf(';'), before.lastIndexOf(':'));
  const clause = before.slice(lastBoundary + 1);
  return /\b(no|without|blocked|blocks|disallow|disallowed|not|cannot|does not|must not|keeps|disabled|false|reference-only|contract-only|non-authorizing|unavailable)\b/i
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

function unsafeActionDriftOk(report, contract = {}) {
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
    'reporting sink',
  ];
  const phraseNeedles = asArray(contract.unsafeActionPhrases).map((phrase) => String(phrase || '').toLowerCase());
  const strings = [
    ...collectStringValues(report.source_recommendation),
    ...collectStringValues(report.satisfied_prior_recommendations),
    ...collectStringValues(report.current_truth),
    ...collectStringValues(report.stale_readiness),
    ...collectStringValues(report.phase34_prior_recommendations),
    ...collectStringValues(report.closure_summary),
    ...collectStringValues(report.source_refs),
    ...collectStringValues(report.gap_summary),
    ...collectStringValues(report.readiness_gap_matrix),
    ...collectStringValues(report.dry_run_boundary),
    ...collectStringValues(report.capability_matrix),
    ...collectStringValues(report.boundary_truth),
    ...collectStringValues(report.redaction_summary),
    ...collectStringValues(report.unsafe_action_policy),
    ...collectStringValues(report.next_phase_recommendations),
    ...collectStringValues(report.evidenceRefs),
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
      throw new Error(`runtime_dry_run_readiness_gap_forbidden_substring:${forbidden}`);
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

function validateGapReport(report = {}, contract = {}) {
  const checks = [];
  const errors = [];
  const resultById = {};
  const add = (id, ok) => {
    const result = resultObject(id, ok);
    checks.push(result);
    resultById[id] = result;
    if (!ok) errors.push(id);
  };

  const outputShapeOk = report.schema === RUNTIME_DRY_RUN_READINESS_GAP_SCHEMA_VERSION
    && hasRequiredFields(report, expectedManifestShape(contract).requiredFields || REQUIRED_GAP_REPORT_FIELDS);
  const baselineOk = report.baseline_commit === BASELINE_COMMIT;
  const phase38Ok = currentTruthOk(report, 38);
  const phase35Ok = currentTruthOk(report, 35);
  const phase36Ok = currentTruthOk(report, 36);
  const phase37Ok = currentTruthOk(report, 37);
  const registryOk = registryCountsOk(report);
  const chainOk = commitChainOk(report, contract);
  const sourceOk = sourceRecommendationOk(report, contract);
  const satisfiedOk = satisfiedPriorOk(report, contract);
  const priorValidatorOk = phase34PriorRecommendationsOk(report, 'phase35_runtime_status_milestone_refresh_validator');
  const priorCliOk = phase34PriorRecommendationsOk(report, 'phase35_stdout_only_cli_smoke');
  const priorOk = priorValidatorOk && priorCliOk;
  const phase13Ok = staleReadinessOk(report, 13);
  const phase23Ok = staleReadinessOk(report, 23);
  const phase31Ok = staleReadinessOk(report, 31);
  const closureOk = closuresOk(report, contract);
  const refsOk = sourceRefsOk(report, contract);
  const recentPathsOk = recentPhasePathsOk(report, contract);
  const gapMatrixOk = readinessGapMatrixOk(report, contract);
  const summaryOk = gapSummaryOk(report);
  const gapsUnsatisfied = gapsUnsatisfiedOk(report);
  const gapsRuntime = gapsBlockRuntimeOk(report);
  const gapsDryRun = gapsBlockDryRunOk(report);
  const gapsNonAuth = gapsNonAuthorizingOk(report);
  const boundaryOk = dryRunBoundaryOk(report);
  const gapAuthOk = dryRunGapsDoNotAuthorizeRuntimeOk(report);
  const capabilityOk = capabilityTruthOk(report);
  const proofOk = proofBoundariesOk(report);
  const sideEffectOk = sideEffectValuesOk(report.side_effect_result);
  const scopeOk = noModuleCliTestRuntimeWorkOk(report);
  let forbiddenOk = true;
  try {
    assertNoForbiddenOutput(report, asArray(contract.forbiddenOutputSubstrings));
  } catch {
    forbiddenOk = false;
  }
  const redactionOk = redactionSummaryOk(report) && forbiddenOk;
  const recommendationsOk = nextRecommendationsOk(report, contract);
  const recommendationsNonAuth = recommendationsOk
    && asArray(report.next_phase_recommendations).every((item) => (
      item.does_not_authorize_ui === true
      && item.does_not_authorize_runtime === true
      && item.does_not_authorize_execution === true
    ));
  const unsafeOk = unsafeActionDriftOk(report, contract);
  const literalsOk = literalValuesOk(report, expectedManifestShape(contract).requiredLiteralValues || {});
  const idempotencyOk = report.idempotency_key === runtimeDryRunReadinessGapIdempotencyKey(report);

  const staticRuleOk = {
    'baseline-pinned-85c78ab': baselineOk,
    'phase38-current': phase38Ok,
    'phase35-current-preserved': phase35Ok,
    'phase36-current-preserved': phase36Ok,
    'phase37-current-preserved': phase37Ok,
    'phase-inventory-count-38': registryOk,
    'schema-registry-count-38': registryOk,
    'cli-registry-count-38': registryOk,
    'commit-chain-exact-26': chainOk,
    'source-recommendation-tier1-selected': sourceOk,
    'phase38-tier0-satisfied-not-open': satisfiedOk,
    'phase34-prior-recommendations-satisfied': priorOk,
    'phase13-stale-preserved': phase13Ok,
    'phase23-stale-preserved': phase23Ok,
    'phase31-stale-preserved': phase31Ok,
    'closures-carried-oracle-115-123-127-131-134-137-141-148-149': closureOk,
    'source-refs-phase29-30-32-33-34-35-36-37-38': refsOk,
    'recent-phase-paths-present': recentPathsOk,
    'readiness-gap-count-exact-9': gapMatrixOk && summaryOk,
    'readiness-gaps-unsatisfied-and-blocking': gapMatrixOk && gapsUnsatisfied && gapsRuntime && gapsDryRun && gapsNonAuth,
    'dry-run-boundary-disabled-local-only': boundaryOk,
    'dry-run-gaps-do-not-authorize-runtime': gapAuthOk,
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
    'baseline-85c78ab-pinned': baselineOk,
    'phase38-current-85c78ab': phase38Ok,
    'phase35-current-preserved': phase35Ok,
    'phase36-current-preserved': phase36Ok,
    'phase37-current-preserved': phase37Ok,
    'phase-inventory-exactly-38': registryOk,
    'schema-registry-exactly-38': registryOk,
    'cli-registry-exactly-38': registryOk,
    'commit-chain-count-26-ending-85c78ab': chainOk,
    'source-tier1-readiness-gap-selected': sourceOk,
    'phase38-tier0-validator-satisfied': satisfiedOk,
    'phase38-tier0-validator-not-reopened': satisfiedOk,
    'phase34-prior-validator-satisfied-not-reopened': priorValidatorOk,
    'phase34-prior-cli-smoke-satisfied-not-reopened': priorCliOk,
    'phase13-stale-truth-preserved': phase13Ok,
    'phase23-stale-truth-preserved': phase23Ok,
    'phase31-stale-superseded-by-phase34': phase31Ok,
    'closures-oracle-115-123-127-131-134-137-141-148-149-present': closureOk,
    'source-refs-phase29-30-32-33-34-35-36-37-38-present': refsOk,
    'recent-phase-paths-present': recentPathsOk,
    'readiness-gap-matrix-exactly-9': gapMatrixOk,
    'readiness-gap-ids-complete': gapMatrixOk,
    'readiness-gaps-unsatisfied': gapsUnsatisfied,
    'readiness-gaps-block-runtime-now': gapsRuntime,
    'readiness-gaps-block-dry-run-now': gapsDryRun,
    'readiness-gaps-non-authorizing': gapsNonAuth,
    'dry-run-boundary-disabled-local-only': boundaryOk,
    'runtime-started-false': report.capability_matrix?.runtimeStarted === false
      && report.boundary_truth?.runtimeStarted === false
      && report.side_effect_result?.runtimeStarted === false,
    'runner-executed-false': report.capability_matrix?.runnerExecuted === false
      && report.boundary_truth?.runnerExecuted === false
      && report.side_effect_result?.runnerExecuted === false,
    'runtime-available-false': report.capability_matrix?.runtimeAvailable === false
      && report.boundary_truth?.runtimeAvailable === false
      && report.side_effect_result?.runtimeAvailable === false,
    'server-can-execute-local-false': report.capability_matrix?.serverCanExecuteLocal === false
      && report.boundary_truth?.serverCanExecuteLocal === false,
    'server-can-prove-model-processing-false': report.capability_matrix?.serverCanProveModelProcessing === false
      && report.boundary_truth?.serverCanProveModelProcessing === false,
    'builder-oracle-direct-targets-blocked': report.capability_matrix?.directBuilderOracleServerTargetsAllowed === false
      && report.boundary_truth?.builderOracleDirectServerTargetsAllowed === false,
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
  add('gap-report-literal-values', literalsOk);
  add('gap-report-contract-complete',
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

function literalResultsOk(results = [], report = {}, contract = {}) {
  const expected = requiredLiteralResults(report, expectedManifestShape(contract).requiredLiteralValues || {});
  return valuesMatch(asArray(results), expected)
    && results.length >= Number(expectedManifestShape(contract).expectedCounts?.required_literal_results_min || 0);
}

function buildValidationReport(report, contract = {}, generatedAt = report.generated_at) {
  const validation = validateGapReport(report, contract);
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
    version: RUNTIME_DRY_RUN_READINESS_GAP_VERSION,
    validation_id: `runtime-dry-run-readiness-gap-validation-${stableHash({
      report_key: report.idempotency_key,
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
    required_literal_results: requiredLiteralResults(report, expectedManifestShape(contract).requiredLiteralValues || {}),
    referenced_path_results: buildReferencedPathResults(contract),
    forbidden_output_scan: resultObject('forbidden-output-strings-absent', forbiddenScanOk),
    side_effect_truth: sideEffectResult(),
    summary: {
      current_through_phase: report.phase_registry?.current_through_phase,
      phase_registry_count: report.phase_registry?.phase_inventory_count,
      schema_registry_count: report.phase_registry?.schema_registry_count,
      cli_registry_count: report.phase_registry?.cli_registry_count,
      commit_chain_count: asArray(report.commit_chain).length,
      source_ref_count: asArray(report.source_refs).length,
      readiness_gap_count: asArray(report.readiness_gap_matrix).length,
      next_recommendation_count: asArray(report.next_phase_recommendations).length,
      baseline_commit: report.baseline_commit,
      accepted_validation_only: validation.ok,
    },
  };
  assertNoForbiddenOutput(validationReport, asArray(contract.forbiddenOutputSubstrings));
  return validationReport;
}

function buildMiraCoreRuntimeDryRunReadinessGap(options = {}) {
  const contract = options.contract || {};
  const runtime_dry_run_readiness_gap = buildGapReport(options);
  const validation_report = buildValidationReport(
    runtime_dry_run_readiness_gap,
    contract,
    runtime_dry_run_readiness_gap.generated_at,
  );
  const output = {
    runtime_dry_run_readiness_gap,
    validation_report,
  };
  assertNoForbiddenOutput(output, asArray(contract.forbiddenOutputSubstrings));
  return output;
}

function validateMiraCoreRuntimeDryRunReadinessGapOutput(output = {}, contract = {}) {
  const checks = [];
  const errors = [];
  const add = (id, ok) => {
    checks.push({ id, ok: ok === true });
    if (!ok) errors.push(id);
  };
  const report = output.runtime_dry_run_readiness_gap || {};
  const validationReport = output.validation_report || {};
  const reportValidation = validateGapReport(report, contract);
  const referencedOk = referencedPathResultsOk(validationReport.referenced_path_results, contract);
  const recomputedById = reportValidation.checks.reduce((acc, check) => {
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
    && literalResultsOk(validationReport.required_literal_results, report, contract)
    && referencedOk;
  recomputedById['validation-report-coverage-bound'] =
    resultObject('validation-report-coverage-bound', reportCoverageOk);

  add('output-shape-complete',
    hasRequiredFields(output, contract.expectedOutputShape?.requiredTopLevelFields || REQUIRED_OUTPUT_FIELDS)
      && report.schema === RUNTIME_DRY_RUN_READINESS_GAP_SCHEMA_VERSION
      && validationReport.schema === VALIDATION_REPORT_SCHEMA_VERSION
      && hasRequiredFields(report, contract.expectedManifestShape?.requiredFields || REQUIRED_GAP_REPORT_FIELDS)
      && hasRequiredFields(validationReport, contract.expectedValidationReportShape?.requiredFields || REQUIRED_VALIDATION_REPORT_FIELDS));

  for (const check of reportValidation.checks) {
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
    validationReport.accepted === reportValidation.ok
      && validationReport.blocked === !reportValidation.ok
      && validationReport.decision === (reportValidation.ok ? 'accepted_validation_only' : 'rejected')
      && valuesMatch(
        asArray(validationReport.reasons),
        reportValidation.checks.filter((check) => !check.ok).map((check) => check.id),
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
  REQUIRED_GAP_REPORT_FIELDS,
  REQUIRED_OUTPUT_FIELDS,
  REQUIRED_SIDE_EFFECT_FIELDS,
  REQUIRED_VALIDATION_REPORT_FIELDS,
  RUNTIME_DRY_RUN_READINESS_GAP_SCHEMA_VERSION,
  VALIDATION_REPORT_SCHEMA_VERSION,
  assertNoForbiddenOutput,
  buildMiraCoreRuntimeDryRunReadinessGap,
  runtimeDryRunReadinessGapIdempotencyKey,
  stableHash,
  validateMiraCoreRuntimeDryRunReadinessGapOutput,
};
