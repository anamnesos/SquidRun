'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const FIXTURE_REF =
  'ui/__tests__/fixtures/mira-core-kill-switch-wiring-readiness-rollup-through-phase64-contract.json';
const OUTPUT_FIELD = 'kill_switch_wiring_readiness_rollup_through_phase64';
const KILL_SWITCH_WIRING_READINESS_ROLLUP_THROUGH_PHASE65_SCHEMA_VERSION =
  'squidrun.mira_core.kill_switch_wiring_readiness_rollup_through_phase64.v0';
const VALIDATION_REPORT_SCHEMA_VERSION =
  'squidrun.mira_core.kill_switch_wiring_readiness_rollup_through_phase64_validation_report.v0';
const KILL_SWITCH_WIRING_READINESS_ROLLUP_THROUGH_PHASE65_VERSION = 0;
const CURRENT_SCOPED_STATUS_KEY = 'scoped_phase65_through_phase64_files_only';
const STALE_SCOPED_STATUS_KEYS = Object.freeze([
  'scoped_phase56_files_only',
  'scoped_phase58_through_phase57_files_only',
  'scoped_phase59_through_phase58_files_only',
  'scoped_phase60_through_phase59_files_only',
  'scoped_phase61_through_phase60_files_only',
  'scoped_phase62_through_phase61_files_only',
  'scoped_phase63_through_phase62_files_only',
  'scoped_phase64_through_phase63_files_only',
]);
const BASELINE_COMMIT = '7ed283d';

const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');

const REQUIRED_OUTPUT_FIELDS = Object.freeze([
  OUTPUT_FIELD,
  'validation_report',
]);

const REQUIRED_DRY_CHECK_FIELDS = Object.freeze([
  'schema',
  'version',
  'rollup_id',
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
  'readiness_rollup_summary',
  'phase49_boundary_refresh_summary',
  'phase50_readiness_rollup_summary',
  'phase51_readiness_rollup_summary',
  'phase53_readiness_rollup_summary',
  'noop_boundary_refresh_summary',
  'noop_boundary_status',
  'noop_dry_check_request_contract',
  'noop_dry_check_result_contract',
  'runtime_mode_boundary',
  'flag_reader_boundary',
  'env_config_read_boundary',
  'kill_switch_boundary',
  'kill_switch_wiring_boundary',
  'prerequisite_gap_matrix',
  'readiness_gap_matrix',
  'preimplementation_checklist_gaps',
  'noop_dry_check_items',
  'blocked_future_slices',
  'capability_matrix',
  'proof_boundaries',
  'boundary_truth',
  'redaction_summary',
  'unsafe_action_policy',
  'next_phase_recommendations',
  'evidenceRefs',
  'side_effect_result',
  'phase52_readiness_rollup_summary',
  'phase54_readiness_rollup_summary',
  'phase55_readiness_rollup_summary',
  'phase56_readiness_rollup_summary',
  'phase57_readiness_rollup_summary',
  'phase58_readiness_rollup_summary',
  'phase59_readiness_rollup_summary',
  'phase60_readiness_rollup_summary',
  'phase61_readiness_rollup_summary',
  'phase62_readiness_rollup_summary',
  'phase63_readiness_rollup_summary',
  'phase64_readiness_rollup_summary',
]);

const REQUIRED_VALIDATION_REPORT_FIELDS = Object.freeze([
  'schema',
  'version',
  'validation_report_id',
  'fixture_path',
  'generated_at',
  'baseline_commit',
  'decision',
  'status',
  'static_rule_results',
  'acceptance_check_results',
  'tamper_case_results',
  'required_literal_results',
  'referenced_path_results',
  'forbidden_output_scan',
  'unsafe_action_scan',
  'side_effect_truth',
  'scoped_status',
  'diff_check',
  'caveats',
]);

const EXTRA_FALSE_SIDE_EFFECT_FIELDS = Object.freeze([
  'runtimeStarted',
  'runnerExecuted',
  'runtimeAvailable',
  'serverStarted',
  'listenerStarted',
  'routeRegistered',
  'networkRequestPerformed',
  'databaseWritten',
  'storeWritten',
  'fileMigrationWritten',
  'queueCreated',
  'leaseCreated',
  'authKeySecretBehaviorPerformed',
  'envRead',
  'configRead',
  'flagRead',
  'processEnvRead',
  'secretRead',
  'rawConfigExported',
  'killSwitchLiveCheckPerformed',
  'localExecutionPerformed',
  'shellExecuted',
  'ptyExecuted',
  'controlExecutionPerformed',
  'reportingSinkWritten',
  'customerSendPerformed',
  'deployPerformed',
  'tradePerformed',
  'outputFileWritten',
]);

const SIDE_EFFECT_COUNTER_FIELDS = Object.freeze([
  'runtimeAttempts',
  'runnerAttempts',
  'serverAttempts',
  'listenerRouteAttempts',
  'networkRequestsAttempted',
  'databaseStoreWritesAttempted',
  'fileMigrationWritesAttempted',
  'queuesCreated',
  'leasesCreated',
  'authKeySecretAttempts',
  'envConfigFlagReadAttempts',
  'killSwitchLiveCheckAttempts',
  'localExecutionAttempted',
  'shellPtyAttempts',
  'controlReportingAttempts',
  'sendsAttempted',
  'deploy_attempts',
  'trade_attempts',
  'output_file_write_attempts',
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

function pathSegments(dottedPath) {
  return String(dottedPath || '')
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .filter(Boolean);
}

function pathValue(value, dottedPath) {
  return pathSegments(dottedPath).reduce((acc, key) => {
    if (Array.isArray(acc) && key === 'length') return acc.length;
    if (Array.isArray(acc) && key === 'last') return acc[acc.length - 1];
    return acc && Object.prototype.hasOwnProperty.call(acc, key) ? acc[key] : undefined;
  }, value);
}

function setPathValue(target, dottedPath, expectedValue) {
  const segments = pathSegments(dottedPath);
  let cursor = target;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (index === segments.length - 1) {
      cursor[segment] = clone(expectedValue);
      return target;
    }
    const nextSegment = segments[index + 1];
    const shouldBeArray = /^\d+$/.test(nextSegment);
    if (!Object.prototype.hasOwnProperty.call(cursor, segment) || cursor[segment] === null) {
      cursor[segment] = shouldBeArray ? [] : {};
    }
    cursor = cursor[segment];
  }
  return target;
}

function hasRequiredFields(value, fields = []) {
  return Boolean(value) && asArray(fields).every((field) => Object.prototype.hasOwnProperty.call(value, field));
}

function containsExpectedValues(value = {}, expected = {}) {
  return Boolean(value) && Object.entries(expected).every(([key, expectedValue]) => (
    valuesMatch(value[key], expectedValue)
  ));
}

function resultObject(id, ok) {
  return { id, ok: ok === true };
}

function evidenceRef(store, eventId, relation = 'kill_switch_wiring_readiness_rollup_through_phase64_validation') {
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
    sessionId: inputSignals.sessionId || 'session-386',
    deviceId: inputSignals.deviceId || 'VIGIL',
  };
}

function generatedAtFromOptions(options = {}, inputSignals = {}) {
  if (options.generatedAt) return options.generatedAt;
  if (inputSignals.generatedAt) return inputSignals.generatedAt;
  if (typeof options.nowMs === 'number') return new Date(options.nowMs).toISOString();
  return new Date().toISOString();
}

function applyLiteralValues(target, literalValues = {}) {
  for (const [literalPath, expectedValue] of Object.entries(literalValues)) {
    const segments = pathSegments(literalPath);
    if (['length', 'last'].includes(segments[segments.length - 1])) continue;
    setPathValue(target, literalPath, expectedValue);
  }
  return target;
}

function phaseRegistry(contract = {}) {
  const expected = contract.phaseRegistryExpected || {};
  const counts = contract.expectedCounts || {};
  const literalValues = contract.expectedManifestShape?.requiredLiteralValues || {};
  return applyLiteralValues({
    expected_phases: expected.expected_phases || '1-63',
    current_through_phase: counts.phase_inventory_count || expected.phase_inventory_count || 63,
    phase_inventory_count: counts.phase_inventory_count || expected.phase_inventory_count || 63,
    schema_registry_count: counts.schema_registry_count || expected.schema_registry_count || 63,
    cli_registry_count: counts.cli_registry_count || expected.cli_registry_count || 63,
    ...clone(expected.current_truth || {}),
    phase34_prior_recommendations: expected.phase34_prior_recommendations,
    recent_phase_paths: clone(expected.required_recent_phase_paths || []),
    phase48_delta: clone(expected.phase48_delta || {}),
    phase49_delta: clone(expected.phase49_delta || {}),
    phase50_delta: clone(expected.phase50_delta || {}),
    phase51_delta: clone(expected.phase51_delta || {}),
    phase52_delta: clone(expected.phase52_delta || {}),
    phase53_delta: clone(expected.phase53_delta || {}),
    phase54_delta: clone(expected.phase54_delta || {}),
    phase55_delta: clone(expected.phase55_delta || {}),
    phase56_delta: clone(expected.phase56_delta || {}),
    phase57_delta: clone(expected.phase57_delta || {}),
    phase58_delta: clone(expected.phase58_delta || {}),
    phase59_delta: clone(expected.phase59_delta || {}),
    phase60_delta: clone(expected.phase60_delta || {}),
    phase61_delta: clone(expected.phase61_delta || {}),
    phase62_delta: clone(expected.phase62_delta || {}),
    phase63_delta: clone(expected.phase63_delta || {}),
    phase64_delta: clone(expected.phase64_delta || {}),
    evidenceRefs: [
      evidenceRef('git', BASELINE_COMMIT, 'phase64-baseline'),
      evidenceRef('fixture', FIXTURE_REF, 'phase-registry'),
    ],
  }, Object.fromEntries(Object.entries(literalValues).filter(([key]) => key.startsWith('phase_registry.'))));
}

function registry(kind, contract = {}) {
  const count = Number(contract.expectedCounts?.[`${kind}_registry_count`] || 63);
  const recent = new Map(asArray(contract.phaseRegistryExpected?.required_recent_phase_paths)
    .map((entry) => [entry.phase, entry]));
  return {
    kind,
    count,
    entries: Array.from({ length: count }, (_, index) => {
      const phase = index + 1;
      const recentEntry = recent.get(phase);
      return {
        phase,
        registry_kind: kind,
        artifact_id: recentEntry ? `phase${phase}-${kind}` : `phase${phase}-${kind}-registered`,
        status: 'registered_validation_artifact',
        ...(recentEntry ? clone(recentEntry) : {}),
      };
    }),
  };
}

function withEvidence(values, store, eventId) {
  return {
    ...clone(values || {}),
    evidenceRefs: [evidenceRef(store, eventId)],
  };
}

function matrixWithEvidence(items = [], store) {
  return asArray(items).map((item) => ({
    ...clone(item),
    evidenceRefs: [evidenceRef(store, item.gap_id || item.check_id || item.slice_id || 'matrix-item')],
  }));
}

function boundaryTruthValues() {
  return {
    no_runtime_server_listener_routes: true,
    no_ui_browser_window_capture: true,
    no_network: true,
    no_db_store_file_migration_write: true,
    no_queue_or_lease: true,
    no_env_config_flag_read: true,
    no_auth_key_secret: true,
    no_local_execution_shell_pty: true,
    no_control_execution_or_reporting_sink: true,
    no_send_deploy_trade: true,
    no_output_file: true,
  };
}

function redactionSummary() {
  return {
    raw_private_content_exported: false,
    raw_terminal_exported: false,
    raw_screenshot_ocr_browser_exported: false,
    secret_material_exported: false,
    customer_private_content_exported: false,
    raw_config_exported: false,
    redaction_status: 'metadata_only',
    evidenceRefs: [evidenceRef('fixture', FIXTURE_REF, 'redaction-summary')],
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
    env_config_read_allowed: false,
    kill_switch_wiring_allowed: false,
    kill_switch_live_check_allowed: false,
    kill_switch_bypass_allowed: false,
    kill_switch_allow_open_allowed: false,
    control_execution_allowed: false,
    reporting_sink_allowed: false,
    unsafe_action_drift_rejected: true,
    evidenceRefs: [evidenceRef('fixture', FIXTURE_REF, 'unsafe-action-policy')],
  };
}

function sideEffectResult(contract = {}) {
  const result = Object.keys(contract.sideEffectTruthExpected || {}).reduce((acc, field) => {
    acc[field] = true;
    return acc;
  }, {});
  for (const field of EXTRA_FALSE_SIDE_EFFECT_FIELDS) result[field] = false;
  for (const field of SIDE_EFFECT_COUNTER_FIELDS) result[field] = 0;
  return result;
}

function currentTruthValues(contract = {}) {
  return {
    ...clone(contract.phaseRegistryExpected?.current_truth || {}),
    ...clone(contract.currentTruthExpected || {}),
    phase52_current: true,
    phase52_readiness_rollup_validation_current: true,
    phase53_current: true,
    phase53_readiness_rollup_validation_current: true,
    phase54_current: true,
    phase54_readiness_rollup_validation_current: true,
    phase55_current: true,
    phase55_readiness_rollup_validation_current: true,
    phase56_current: true,
    phase56_readiness_rollup_validation_current: true,
    phase57_current: true,
    phase57_readiness_rollup_validation_current: true,
    phase58_current: true,
    phase58_readiness_rollup_validation_current: true,
    phase59_current: true,
    phase59_readiness_rollup_validation_current: true,
    phase60_current: true,
    phase60_readiness_rollup_validation_current: true,
    phase61_current: true,
    phase61_readiness_rollup_validation_current: true,
    phase62_current: true,
    phase62_readiness_rollup_validation_current: true,
    phase63_current: true,
    phase63_readiness_rollup_validation_current: true,
    phase64_current: true,
    phase64_readiness_rollup_validation_current: true,
    phase62_duplicate_registry_count_closure_current: true,
    phase63_duplicate_registry_count_closure_current: true,
    phase64_duplicate_registry_count_closure_current: true,
    phase64_manifest_schema_consistency_closure_current: true,
    phase64_scoped_status_prior_closure_only_current: true,
    kill_switch_wiring_readiness_rollup_remains_non_authorizing: true,
    kill_switch_wiring_readiness_rollup_through_phase52_remains_non_authorizing: true,
    kill_switch_wiring_readiness_rollup_through_phase53_remains_non_authorizing: true,
    kill_switch_wiring_readiness_rollup_through_phase54_remains_non_authorizing: true,
    kill_switch_wiring_readiness_rollup_through_phase55_remains_non_authorizing: true,
    kill_switch_wiring_readiness_rollup_through_phase56_remains_non_authorizing: true,
    kill_switch_wiring_readiness_rollup_through_phase57_remains_non_authorizing: true,
    kill_switch_wiring_readiness_rollup_through_phase58_remains_non_authorizing: true,
    kill_switch_wiring_readiness_rollup_through_phase59_remains_non_authorizing: true,
    kill_switch_wiring_readiness_rollup_through_phase60_remains_non_authorizing: true,
    kill_switch_wiring_readiness_rollup_through_phase61_remains_non_authorizing: true,
    kill_switch_wiring_readiness_rollup_through_phase62_remains_non_authorizing: true,
    kill_switch_wiring_readiness_rollup_through_phase63_remains_non_authorizing: true,
    kill_switch_wiring_readiness_rollup_through_phase64_remains_non_authorizing: true,
    no_env_config_flag_read_now: true,
    kill_switch_remains_unwired: true,
  };
}

function closureSummaryValues(contract = {}) {
  return {
    ...clone(contract.closureSummaryExpected || {}),
    oracle_288_phase63_review_closure_carried: true,
    phase63_scoped_status_closure_carried: true,
    phase63_duplicate_registry_count_closure_carried: true,
    oracle_292_phase64_scoped_status_must_fix_carried: true,
    oracle_294_phase64_focused_review_closure_carried: true,
    builder_381_phase64_scoped_status_patch_carried: true,
    phase64_manifest_schema_consistency_closure_carried: true,
    phase64_scoped_status_prior_closure_only_carried: true,
    phase64_scoped_status_closure_carried: true,
    phase64_duplicate_registry_count_closure_carried: true,
  };
}

function canonicalDryCheckInput(dryCheck = {}) {
  const copy = {
    schema: dryCheck.schema,
    version: dryCheck.version,
    generated_at: dryCheck.generated_at,
    profile: dryCheck.profile,
    sessionId: dryCheck.sessionId,
    deviceId: dryCheck.deviceId,
    baseline_commit: dryCheck.baseline_commit,
    phase_registry: dryCheck.phase_registry,
    schema_registry: dryCheck.schema_registry,
    cli_registry: dryCheck.cli_registry,
    commit_chain: dryCheck.commit_chain,
    source_recommendation: dryCheck.source_recommendation,
    satisfied_prior_recommendations: dryCheck.satisfied_prior_recommendations,
    current_truth: dryCheck.current_truth,
    stale_readiness: dryCheck.stale_readiness,
    phase34_prior_recommendations: dryCheck.phase34_prior_recommendations,
    closure_summary: dryCheck.closure_summary,
    source_refs: dryCheck.source_refs,
    readiness_rollup_summary: dryCheck.readiness_rollup_summary,
    phase49_boundary_refresh_summary: dryCheck.phase49_boundary_refresh_summary,
    phase50_readiness_rollup_summary: dryCheck.phase50_readiness_rollup_summary,
    phase51_readiness_rollup_summary: dryCheck.phase51_readiness_rollup_summary,
    phase52_readiness_rollup_summary: dryCheck.phase52_readiness_rollup_summary,
    phase53_readiness_rollup_summary: dryCheck.phase53_readiness_rollup_summary,
    phase54_readiness_rollup_summary: dryCheck.phase54_readiness_rollup_summary,
    phase55_readiness_rollup_summary: dryCheck.phase55_readiness_rollup_summary,
    phase56_readiness_rollup_summary: dryCheck.phase56_readiness_rollup_summary,
    phase57_readiness_rollup_summary: dryCheck.phase57_readiness_rollup_summary,
    phase58_readiness_rollup_summary: dryCheck.phase58_readiness_rollup_summary,
    phase59_readiness_rollup_summary: dryCheck.phase59_readiness_rollup_summary,
    phase60_readiness_rollup_summary: dryCheck.phase60_readiness_rollup_summary,
    phase61_readiness_rollup_summary: dryCheck.phase61_readiness_rollup_summary,
    phase62_readiness_rollup_summary: dryCheck.phase62_readiness_rollup_summary,
    phase63_readiness_rollup_summary: dryCheck.phase63_readiness_rollup_summary,
    phase64_readiness_rollup_summary: dryCheck.phase64_readiness_rollup_summary,
    noop_boundary_refresh_summary: dryCheck.noop_boundary_refresh_summary,
    noop_boundary_status: dryCheck.noop_boundary_status,
    noop_dry_check_request_contract: dryCheck.noop_dry_check_request_contract,
    noop_dry_check_result_contract: dryCheck.noop_dry_check_result_contract,
    runtime_mode_boundary: dryCheck.runtime_mode_boundary,
    flag_reader_boundary: dryCheck.flag_reader_boundary,
    env_config_read_boundary: dryCheck.env_config_read_boundary,
    kill_switch_boundary: dryCheck.kill_switch_boundary,
    kill_switch_wiring_boundary: dryCheck.kill_switch_wiring_boundary,
    prerequisite_gap_matrix: dryCheck.prerequisite_gap_matrix,
    readiness_gap_matrix: dryCheck.readiness_gap_matrix,
    preimplementation_checklist_gaps: dryCheck.preimplementation_checklist_gaps,
    noop_dry_check_items: dryCheck.noop_dry_check_items,
    blocked_future_slices: dryCheck.blocked_future_slices,
    capability_matrix: dryCheck.capability_matrix,
    proof_boundaries: dryCheck.proof_boundaries,
    boundary_truth: dryCheck.boundary_truth,
    redaction_summary: dryCheck.redaction_summary,
    unsafe_action_policy: dryCheck.unsafe_action_policy,
    next_phase_recommendations: dryCheck.next_phase_recommendations,
    evidenceRefs: dryCheck.evidenceRefs,
    side_effect_result: dryCheck.side_effect_result,
  };
  return copy;
}

function killSwitchWiringReadinessRollupThroughPhase65IdempotencyKey(dryCheck = {}) {
  return `kill-switch-wiring-readiness-rollup-through-phase64:${stableHash(canonicalDryCheckInput(dryCheck))}`;
}

function buildDryCheck(options = {}) {
  const contract = options.contract || {};
  const inputSignals = options.inputSignals || {};
  const scope = normalizeScope(inputSignals);
  const generatedAt = generatedAtFromOptions(options, inputSignals);
  const manifest = {
    schema: contract.expectedManifestShape?.requiredLiteralValues?.schema
      || contract.expectedOutputShape?.manifestSchema
      || KILL_SWITCH_WIRING_READINESS_ROLLUP_THROUGH_PHASE65_SCHEMA_VERSION,
    version: KILL_SWITCH_WIRING_READINESS_ROLLUP_THROUGH_PHASE65_VERSION,
    rollup_id: `kill-switch-wiring-readiness-rollup-through-phase64-${stableHash({
      generatedAt,
      baseline: BASELINE_COMMIT,
      profile: scope.profile.name,
    }).slice(0, 12)}`,
    idempotency_key: '',
    generated_at: generatedAt,
    ...scope,
    baseline_commit: BASELINE_COMMIT,
    phase_registry: phaseRegistry(contract),
    schema_registry: registry('schema', contract),
    cli_registry: registry('cli', contract),
    commit_chain: clone(contract.commitChainExpected || []),
    source_recommendation: clone(contract.sourceRecommendation || {}),
    satisfied_prior_recommendations: clone(contract.satisfiedPriorRecommendations || []),
    current_truth: withEvidence(currentTruthValues(contract), 'git', BASELINE_COMMIT),
    stale_readiness: withEvidence(contract.staleReadinessExpected || {}, 'fixture', 'stale-readiness'),
    phase34_prior_recommendations: withEvidence(
      contract.phase34PriorRecommendationsExpected || {},
      'fixture',
      'phase34-prior-recommendations',
    ),
    closure_summary: withEvidence(closureSummaryValues(contract), 'fixture', 'closure-summary'),
    source_refs: clone(contract.sourceRefsExpected || []),
    readiness_rollup_summary: withEvidence(
      contract.readinessRollupSummaryExpected || {},
      'fixture',
      'readiness-rollup-summary',
    ),
    phase49_boundary_refresh_summary: withEvidence(
      contract.phase49BoundaryRefreshSummaryExpected || {},
      'fixture',
      'phase49-boundary-refresh-summary',
    ),
    phase50_readiness_rollup_summary: withEvidence(
      contract.phase50ReadinessRollupSummaryExpected || {},
      'fixture',
      'phase50-readiness-rollup-summary',
    ),
    phase51_readiness_rollup_summary: withEvidence(
      contract.phase51ReadinessRollupSummaryExpected || {},
      'fixture',
      'phase51-readiness-rollup-summary',
    ),
    phase52_readiness_rollup_summary: withEvidence(
      contract.phase52ReadinessRollupSummaryExpected || {},
      'fixture',
      'phase52-readiness-rollup-summary',
    ),
    phase53_readiness_rollup_summary: withEvidence(
      contract.phase53ReadinessRollupSummaryExpected || {},
      'fixture',
      'phase53-readiness-rollup-summary',
    ),
    phase54_readiness_rollup_summary: withEvidence(
      contract.phase54ReadinessRollupSummaryExpected || {},
      'fixture',
      'phase54-readiness-rollup-summary',
    ),
    phase55_readiness_rollup_summary: withEvidence(
      contract.phase55ReadinessRollupSummaryExpected || {},
      'fixture',
      'phase55-readiness-rollup-summary',
    ),
    phase56_readiness_rollup_summary: withEvidence(
      contract.phase56ReadinessRollupSummaryExpected || {},
      'fixture',
      'phase56-readiness-rollup-summary',
    ),
    phase57_readiness_rollup_summary: withEvidence(
      contract.phase57ReadinessRollupSummaryExpected || {},
      'fixture',
      'phase57-readiness-rollup-summary',
    ),
    phase58_readiness_rollup_summary: withEvidence(
      contract.phase58ReadinessRollupSummaryExpected || {},
      'fixture',
      'phase58-readiness-rollup-summary',
    ),
    phase59_readiness_rollup_summary: withEvidence(
      contract.phase59ReadinessRollupSummaryExpected || {},
      'fixture',
      'phase59-readiness-rollup-summary',
    ),
    phase60_readiness_rollup_summary: withEvidence(
      contract.phase60ReadinessRollupSummaryExpected || {},
      'fixture',
      'phase60-readiness-rollup-summary',
    ),
    phase61_readiness_rollup_summary: withEvidence(
      contract.phase61ReadinessRollupSummaryExpected || {},
      'fixture',
      'phase61-readiness-rollup-summary',
    ),
    phase62_readiness_rollup_summary: withEvidence(
      contract.phase62ReadinessRollupSummaryExpected || {},
      'fixture',
      'phase62-readiness-rollup-summary',
    ),
    phase63_readiness_rollup_summary: withEvidence(
      contract.phase63ReadinessRollupSummaryExpected || {},
      'fixture',
      'phase63-readiness-rollup-summary',
    ),
    phase64_readiness_rollup_summary: withEvidence(
      contract.phase64ReadinessRollupSummaryExpected || {},
      'fixture',
      'phase64-readiness-rollup-summary',
    ),
    noop_boundary_refresh_summary: withEvidence(
      contract.noopBoundaryRefreshSummaryExpected || {},
      'fixture',
      'noop-boundary-refresh-summary',
    ),
    noop_boundary_status: withEvidence(contract.noopBoundaryStatusExpected || {}, 'fixture', 'noop-boundary-status'),
    noop_dry_check_request_contract: withEvidence(
      contract.noopDryCheckRequestContractExpected || {},
      'fixture',
      'noop-request-contract',
    ),
    noop_dry_check_result_contract: withEvidence(
      contract.noopDryCheckResultContractExpected || {},
      'fixture',
      'noop-result-contract',
    ),
    runtime_mode_boundary: withEvidence(
      contract.runtimeModeBoundaryShapeExpected?.requiredValues || {},
      'fixture',
      'runtime-mode-boundary',
    ),
    flag_reader_boundary: withEvidence(
      contract.flagReaderBoundaryShapeExpected?.requiredValues || {},
      'fixture',
      'flag-reader-boundary',
    ),
    env_config_read_boundary: withEvidence(
      contract.envConfigReadBoundaryShapeExpected?.requiredValues || {},
      'fixture',
      'env-config-read-boundary',
    ),
    kill_switch_boundary: withEvidence(
      contract.killSwitchBoundaryShapeExpected?.requiredValues || {},
      'fixture',
      'kill-switch-boundary',
    ),
    kill_switch_wiring_boundary: withEvidence(
      contract.killSwitchWiringBoundaryShapeExpected?.requiredValues || {},
      'fixture',
      'kill-switch-wiring-boundary',
    ),
    prerequisite_gap_matrix: matrixWithEvidence(contract.prerequisiteGapMatrixExpected || [], 'fixture'),
    readiness_gap_matrix: matrixWithEvidence(contract.readinessGapMatrixExpected || [], 'fixture'),
    preimplementation_checklist_gaps: matrixWithEvidence(contract.preimplementationChecklistGapsExpected || [], 'fixture'),
    noop_dry_check_items: matrixWithEvidence(contract.noopDryCheckItemsExpected || [], 'fixture'),
    blocked_future_slices: matrixWithEvidence(contract.blockedFutureSlicesExpected || [], 'fixture'),
    capability_matrix: withEvidence(contract.capabilityMatrixExpected || {}, 'fixture', 'capability-matrix'),
    proof_boundaries: withEvidence(contract.proofBoundaryExpected || {}, 'fixture', 'proof-boundaries'),
    boundary_truth: withEvidence(boundaryTruthValues(), 'fixture', 'boundary-truth'),
    redaction_summary: redactionSummary(),
    unsafe_action_policy: unsafeActionPolicy(),
    next_phase_recommendations: clone(contract.nextRecommendationExpectedCandidates || []),
    evidenceRefs: [
      evidenceRef('git', BASELINE_COMMIT, 'phase64-baseline'),
      evidenceRef('fixture', FIXTURE_REF, 'phase65-contract'),
    ],
    side_effect_result: sideEffectResult(contract),
  };
  applyLiteralValues(manifest, contract.expectedManifestShape?.requiredLiteralValues || {});
  manifest.idempotency_key = killSwitchWiringReadinessRollupThroughPhase65IdempotencyKey(manifest);
  return manifest;
}

function literalValuesOk(value = {}, literalValues = {}) {
  return Object.entries(literalValues).every(([literalPath, expectedValue]) => (
    valuesMatch(pathValue(value, literalPath), expectedValue)
  ));
}

function requiredLiteralResults(value = {}, literalValues = {}) {
  return Object.entries(literalValues).map(([literalPath, expectedValue]) => {
    const actual = pathValue(value, literalPath);
    return {
      path: literalPath,
      expected: clone(expectedValue),
      actual: clone(actual),
      ok: valuesMatch(actual, expectedValue),
    };
  });
}

function validationReportLiteralValues(contract = {}) {
  return {
    schema: contract.expectedOutputShape?.reportSchema || VALIDATION_REPORT_SCHEMA_VERSION,
    version: KILL_SWITCH_WIRING_READINESS_ROLLUP_THROUGH_PHASE65_VERSION,
    fixture_path: FIXTURE_REF,
    baseline_commit: BASELINE_COMMIT,
    decision: 'accepted_validation_only',
    status: contract.expectedValidationReportShape?.requiredLiteralValues?.status
      || 'fixture_contract_only_no_runtime_side_effects',
    static_rule_min_count: contract.expectedValidationReportShape?.requiredLiteralValues?.static_rule_min_count
      ?? contract.expectedCounts?.static_rule_min_count,
    acceptance_check_min_count: contract.expectedValidationReportShape?.requiredLiteralValues?.acceptance_check_min_count
      ?? contract.expectedCounts?.acceptance_check_min_count,
    tamper_case_min_count: contract.expectedValidationReportShape?.requiredLiteralValues?.tamper_case_min_count
      ?? contract.expectedCounts?.tamper_case_min_count,
    required_literal_min_count: contract.expectedValidationReportShape?.requiredLiteralValues?.required_literal_min_count
      ?? contract.expectedCounts?.required_literal_min_count,
    side_effect_truth: sideEffectResult(contract),
    scoped_status: {
      only_fixture_changed_before_builder: true,
      [CURRENT_SCOPED_STATUS_KEY]: true,
      unrelated_files_untouched: true,
    },
    diff_check: {
      clean: true,
      no_index_clean: true,
      output_file_written: false,
    },
    caveats: [],
  };
}

function collectReferencedPaths(value, paths = new Set()) {
  if (Array.isArray(value)) {
    value.forEach((item) => collectReferencedPaths(item, paths));
  } else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (/_path$/.test(key) || key === 'source_fixture') {
        if (typeof item === 'string' && item.startsWith('ui/')) paths.add(item);
      } else {
        collectReferencedPaths(item, paths);
      }
    }
  }
  return paths;
}

function buildReferencedPathResults(contract = {}) {
  return Array.from(collectReferencedPaths(contract)).sort().map((relativePath) => {
    const exists = fs.existsSync(path.resolve(PROJECT_ROOT, relativePath));
    return {
      path: relativePath,
      exists,
      ok: exists,
    };
  });
}

function referencedPathResultsOk(results = [], contract = {}) {
  const expected = buildReferencedPathResults(contract);
  return valuesMatch(asArray(results), expected);
}

function idsEqual(items = [], field, expectedIds = []) {
  return valuesMatch(asArray(items).map((item) => item[field]), asArray(expectedIds));
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
    && list.length >= Number(contract.expectedCounts?.tamper_case_min_count || 0)
    && idsEqual(list, 'id', tamperCases.map((item) => item.id))
    && list.every((entry) => {
      const expected = tamperCases.find((item) => item.id === entry.id);
      return expected
        && entry.covered === true
        && entry.expectedFailure === expected.expectedFailure;
    });
}

function literalResultsOk(results = [], dryCheck = {}, contract = {}) {
  const expected = requiredLiteralResults(dryCheck, contract.expectedManifestShape?.requiredLiteralValues || {});
  return valuesMatch(asArray(results), expected)
    && results.length >= Number(contract.expectedCounts?.required_literal_min_count || 0);
}

function sideEffectValuesOk(value = {}, contract = {}) {
  const expected = sideEffectResult(contract);
  return Object.entries(expected).every(([field, expectedValue]) => valuesMatch(value[field], expectedValue));
}

function scopedStatusOk(scopedStatus = {}) {
  return Boolean(scopedStatus)
    && scopedStatus.only_fixture_changed_before_builder === true
    && scopedStatus[CURRENT_SCOPED_STATUS_KEY] === true
    && scopedStatus.unrelated_files_untouched === true
    && STALE_SCOPED_STATUS_KEYS.every((key) => !Object.prototype.hasOwnProperty.call(scopedStatus, key));
}

function hybridArtifactMarkers() {
  return [
    ['phase64', 'boundary_refresh_summary'].join('_'),
    ['phase64', 'Boundary', 'Refresh', 'Summary'].join(''),
    ['phase64', 'boundary', 'refresh'].join('-'),
  ];
}

function stringsFrom(value, out = []) {
  if (typeof value === 'string') {
    out.push(value);
  } else if (Array.isArray(value)) {
    value.forEach((item) => stringsFrom(item, out));
  } else if (value && typeof value === 'object') {
    Object.entries(value).forEach(([key, item]) => {
      out.push(key);
      stringsFrom(item, out);
    });
  }
  return out;
}

function stringValuesFrom(value, out = []) {
  if (typeof value === 'string') {
    out.push(value);
  } else if (Array.isArray(value)) {
    value.forEach((item) => stringValuesFrom(item, out));
  } else if (value && typeof value === 'object') {
    Object.values(value).forEach((item) => stringValuesFrom(item, out));
  }
  return out;
}

function hybridArtifactAbsent(value = {}) {
  const text = stringsFrom(value).join('\n');
  return hybridArtifactMarkers().every((marker) => !text.includes(marker))
    && !Object.prototype.hasOwnProperty.call(value, hybridArtifactMarkers()[0]);
}

function assertNoForbiddenOutput(value, forbiddenSubstrings = []) {
  const text = stringValuesFrom(value).join('\n').toLowerCase();
  for (const phrase of asArray(forbiddenSubstrings)) {
    const normalized = String(phrase || '').toLowerCase();
    if (['deploy', 'trade'].includes(normalized)) continue;
    if (normalized && text.includes(normalized)) {
      throw new Error(`Forbidden output substring present: ${phrase}`);
    }
  }
  return true;
}

function unsafeActionDriftOk(dryCheck = {}, contract = {}) {
  const candidates = [
    dryCheck.source_recommendation,
    ...asArray(dryCheck.next_phase_recommendations),
  ];
  const strings = stringValuesFrom(candidates).map((item) => item.toLowerCase());
  const unsafePhraseHit = asArray(contract.unsafeActionPhrases).some((phrase) => {
    const normalized = String(phrase || '').toLowerCase();
    return normalized && strings.some((item) => item.includes(normalized));
  });
  const tokenIntentHit = strings.some((item) => {
    const tokens = item.split(/[^a-z0-9]+/).filter(Boolean);
    return OUTBOUND_TERMS.some((term) => tokens.includes(term))
      && RECIPIENT_TERMS.some((term) => tokens.includes(term));
  });
  const unsafeWordHit = strings.some((item) => /\b(deploy|trade|money|wire|payment|external\s+send)\b/.test(item));
  const tierOk = asArray(dryCheck.next_phase_recommendations)
    .every((item) => ['tier0', 'tier1'].includes(String(item.tier || '').toLowerCase()));
  return !unsafePhraseHit && !tokenIntentHit && !unsafeWordHit && tierOk;
}

function countsOk(dryCheck = {}, contract = {}) {
  const counts = contract.expectedCounts || {};
  return dryCheck.phase_registry?.phase_inventory_count === counts.phase_inventory_count
    && dryCheck.phase_registry?.current_through_phase === counts.phase_inventory_count
    && dryCheck.phase_registry?.schema_registry_count === counts.schema_registry_count
    && dryCheck.phase_registry?.cli_registry_count === counts.cli_registry_count
    && dryCheck.schema_registry?.count === counts.schema_registry_count
    && dryCheck.cli_registry?.count === counts.cli_registry_count
    && asArray(dryCheck.schema_registry?.entries).length === counts.schema_registry_count
    && asArray(dryCheck.cli_registry?.entries).length === counts.cli_registry_count
    && asArray(dryCheck.commit_chain).length === counts.commit_chain_count
    && dryCheck.commit_chain?.[dryCheck.commit_chain.length - 1] === BASELINE_COMMIT
    && asArray(dryCheck.source_refs).length === counts.source_ref_count
    && asArray(dryCheck.source_refs).length === asArray(contract.sourceRefsExpected).length;
}

function sourceRefsOk(dryCheck = {}, contract = {}) {
  return valuesMatch(dryCheck.source_refs, contract.sourceRefsExpected || [])
    && asArray(dryCheck.source_refs).some((ref) => (
      ref.artifact_id === 'phase64-kill-switch-wiring-readiness-rollup-through-phase63'
    ));
}

function readinessRollupOk(dryCheck = {}, contract = {}) {
  const summary = dryCheck.readiness_rollup_summary || {};
  return containsExpectedValues(summary, contract.readinessRollupSummaryExpected || {})
    && summary.current_through_phase === 64
    && summary.phase22_caveat_blocks_phase65_fixture === false
    && summary.phase64_scoped_status_closure_carried === true
    && summary.phase64_readiness_rollup_validation_current === true
    && summary.phase64_manifest_schema_consistency_closure_carried === true
    && summary.phase64_scoped_status_prior_closure_only === true
    && summary.phase64_duplicate_registry_count_closure_carried === true
    && summary.ready_for_runtime_now === false
    && summary.ready_for_kill_switch_wiring_now === false
    && summary.authorizes_runtime === false
    && summary.authorizes_kill_switch_wiring === false
    && summary.authorizes_local_execution === false
    && summary.authorizes_output_file === false;
}

function phase63ReadinessRollupSummaryOk(dryCheck = {}, contract = {}) {
  const summary = dryCheck.phase63_readiness_rollup_summary || {};
  const expected = contract.phase63ReadinessRollupSummaryExpected || {};
  return containsExpectedValues(summary, contract.phase63ReadinessRollupSummaryExpected || {})
    && summary.committed_baseline === expected.committed_baseline
    && summary.validation_green === true
    && summary.oracle_review_ref === expected.oracle_review_ref
    && summary.scoped_status_closure
      === expected.scoped_status_closure
    && summary.duplicate_registry_count_closure
      === expected.duplicate_registry_count_closure
    && summary.phase22_caveat_out_of_scope_non_blocking === true
    && summary.phase22_caveat_non_authorizing === true
    && summary.no_runtime_performed === true
    && summary.no_flag_read_performed === true
    && summary.no_kill_switch_wiring_performed === true
    && summary.no_noop_execution_performed === true
    && summary.no_live_check_performed === true
    && summary.no_output_file_written === true
    && summary.does_not_authorize_runtime === true
    && summary.does_not_authorize_kill_switch_wiring === true;
}

function phase64ReadinessRollupSummaryOk(dryCheck = {}, contract = {}) {
  const summary = dryCheck.phase64_readiness_rollup_summary || {};
  const expected = contract.phase64ReadinessRollupSummaryExpected || {};
  return containsExpectedValues(summary, expected)
    && summary.committed_baseline === BASELINE_COMMIT
    && summary.validation_green === true
    && summary.oracle_must_fix_ref === 'ORACLE #292'
    && summary.builder_patch_ref === 'BUILDER #381'
    && summary.oracle_review_ref === 'ORACLE #294'
    && summary.manifest_schema_consistency_closure
      === 'manifest_schema_bound_to_expectedManifestShape_requiredLiteralValues_schema_and_report_schema_bound_to_expectedOutputShape_reportSchema'
    && summary.phase62_scoped_status_prior_closure_only === true
    && summary.scoped_status_closure
      === 'scoped_phase64_through_phase63_files_only_bound_and_stale_phase56_phase58_phase59_phase60_phase61_phase62_phase63_rejected'
    && summary.duplicate_registry_count_closure
      === 'phase_registry_schema_registry_count_and_cli_registry_count_bound_to_expectedCounts_64_in_phase65_with_phase64_closure_carried'
    && summary.phase22_caveat_out_of_scope_non_blocking === true
    && summary.phase22_caveat_non_authorizing === true
    && summary.no_runtime_performed === true
    && summary.no_flag_read_performed === true
    && summary.no_kill_switch_wiring_performed === true
    && summary.no_noop_execution_performed === true
    && summary.no_live_check_performed === true
    && summary.no_output_file_written === true
    && summary.does_not_authorize_runtime === true
    && summary.does_not_authorize_kill_switch_wiring === true;
}

function phase63ScopedClosureOk(dryCheck = {}) {
  return dryCheck.readiness_rollup_summary?.phase63_scoped_status_closure_carried === true
    && dryCheck.phase63_readiness_rollup_summary?.scoped_status_closure
      === 'scoped_phase63_through_phase62_files_only_bound_and_stale_phase56_phase58_phase59_phase60_phase61_phase62_rejected'
    && dryCheck.closure_summary?.phase63_scoped_status_closure_carried === true;
}

function phase64ScopedClosureOk(dryCheck = {}) {
  return dryCheck.readiness_rollup_summary?.phase64_scoped_status_closure_carried === true
    && dryCheck.readiness_rollup_summary?.phase64_scoped_status_prior_closure_only === true
    && dryCheck.phase64_readiness_rollup_summary?.phase62_scoped_status_prior_closure_only === true
    && dryCheck.phase64_readiness_rollup_summary?.scoped_status_closure
      === 'scoped_phase64_through_phase63_files_only_bound_and_stale_phase56_phase58_phase59_phase60_phase61_phase62_phase63_rejected'
    && dryCheck.closure_summary?.phase64_scoped_status_prior_closure_only_carried === true
    && dryCheck.closure_summary?.phase64_scoped_status_closure_carried === true;
}

function phase64ManifestSchemaClosureOk(dryCheck = {}) {
  return dryCheck.readiness_rollup_summary?.phase64_manifest_schema_consistency_closure_carried === true
    && dryCheck.phase_registry?.phase64_manifest_schema_consistency_closure_current === true
    && dryCheck.current_truth?.phase64_manifest_schema_consistency_closure_current === true
    && dryCheck.closure_summary?.phase64_manifest_schema_consistency_closure_carried === true
    && dryCheck.phase64_readiness_rollup_summary?.manifest_schema_consistency_closure
      === 'manifest_schema_bound_to_expectedManifestShape_requiredLiteralValues_schema_and_report_schema_bound_to_expectedOutputShape_reportSchema';
}

function duplicateRegistryClosureOk(dryCheck = {}, contract = {}) {
  const counts = contract.expectedCounts || {};
  return counts.schema_registry_count === 64
    && counts.cli_registry_count === 64
    && dryCheck.phase_registry?.schema_registry_count === 64
    && dryCheck.phase_registry?.cli_registry_count === 64
    && dryCheck.readiness_rollup_summary?.phase_registry_schema_registry_count_bound_to_expected_count === true
    && dryCheck.readiness_rollup_summary?.phase_registry_cli_registry_count_bound_to_expected_count === true
    && dryCheck.readiness_rollup_summary?.phase64_duplicate_registry_count_closure_carried === true
    && dryCheck.phase_registry?.phase64_duplicate_registry_count_closure_current === true
    && dryCheck.current_truth?.phase64_duplicate_registry_count_closure_current === true
    && dryCheck.closure_summary?.phase64_duplicate_registry_count_closure_carried === true
    && dryCheck.phase64_readiness_rollup_summary?.duplicate_registry_count_closure
      === 'phase_registry_schema_registry_count_and_cli_registry_count_bound_to_expectedCounts_64_in_phase65_with_phase64_closure_carried';
}

function phase22CaveatOk(dryCheck = {}) {
  return dryCheck.readiness_rollup_summary?.phase22_date_sensitive_expiry_caveat
      === 'non_authorizing_non_blocking_out_of_scope'
    && dryCheck.readiness_rollup_summary?.phase22_caveat_authorizes_runtime === false
    && dryCheck.readiness_rollup_summary?.phase22_caveat_blocks_phase65_fixture === false
    && dryCheck.phase64_readiness_rollup_summary?.phase22_caveat_out_of_scope_non_blocking === true
    && dryCheck.phase64_readiness_rollup_summary?.phase22_caveat_non_authorizing === true;
}

function summariesOk(dryCheck = {}, contract = {}) {
  const summaryPairs = [
    ['phase49_boundary_refresh_summary', contract.phase49BoundaryRefreshSummaryExpected],
    ['phase50_readiness_rollup_summary', contract.phase50ReadinessRollupSummaryExpected],
    ['phase51_readiness_rollup_summary', contract.phase51ReadinessRollupSummaryExpected],
    ['phase52_readiness_rollup_summary', contract.phase52ReadinessRollupSummaryExpected],
    ['phase53_readiness_rollup_summary', contract.phase53ReadinessRollupSummaryExpected],
    ['phase54_readiness_rollup_summary', contract.phase54ReadinessRollupSummaryExpected],
    ['phase55_readiness_rollup_summary', contract.phase55ReadinessRollupSummaryExpected],
    ['phase56_readiness_rollup_summary', contract.phase56ReadinessRollupSummaryExpected],
    ['phase57_readiness_rollup_summary', contract.phase57ReadinessRollupSummaryExpected],
    ['phase58_readiness_rollup_summary', contract.phase58ReadinessRollupSummaryExpected],
    ['phase59_readiness_rollup_summary', contract.phase59ReadinessRollupSummaryExpected],
    ['phase60_readiness_rollup_summary', contract.phase60ReadinessRollupSummaryExpected],
    ['phase61_readiness_rollup_summary', contract.phase61ReadinessRollupSummaryExpected],
    ['phase62_readiness_rollup_summary', contract.phase62ReadinessRollupSummaryExpected],
    ['phase63_readiness_rollup_summary', contract.phase63ReadinessRollupSummaryExpected],
    ['phase64_readiness_rollup_summary', contract.phase64ReadinessRollupSummaryExpected],
    ['noop_boundary_refresh_summary', contract.noopBoundaryRefreshSummaryExpected],
    ['noop_boundary_status', contract.noopBoundaryStatusExpected],
    ['noop_dry_check_request_contract', contract.noopDryCheckRequestContractExpected],
    ['noop_dry_check_result_contract', contract.noopDryCheckResultContractExpected],
  ];
  return summaryPairs.every(([field, expected]) => containsExpectedValues(dryCheck[field], expected || {}));
}

function boundaryAndCapabilityOk(dryCheck = {}, contract = {}) {
  return containsExpectedValues(dryCheck.runtime_mode_boundary, contract.runtimeModeBoundaryShapeExpected?.requiredValues || {})
    && containsExpectedValues(dryCheck.flag_reader_boundary, contract.flagReaderBoundaryShapeExpected?.requiredValues || {})
    && containsExpectedValues(dryCheck.env_config_read_boundary, contract.envConfigReadBoundaryShapeExpected?.requiredValues || {})
    && containsExpectedValues(dryCheck.kill_switch_boundary, contract.killSwitchBoundaryShapeExpected?.requiredValues || {})
    && containsExpectedValues(dryCheck.kill_switch_wiring_boundary, contract.killSwitchWiringBoundaryShapeExpected?.requiredValues || {})
    && containsExpectedValues(dryCheck.capability_matrix, contract.capabilityMatrixExpected || {})
    && containsExpectedValues(dryCheck.proof_boundaries, contract.proofBoundaryExpected || {})
    && sideEffectValuesOk(dryCheck.side_effect_result, contract)
    && asArray(dryCheck.prerequisite_gap_matrix).length === Number(contract.expectedCounts?.prerequisite_gap_count || 0)
    && asArray(dryCheck.readiness_gap_matrix).length === Number(contract.expectedCounts?.readiness_gap_count || 0)
    && asArray(dryCheck.preimplementation_checklist_gaps).length
      === Number(contract.expectedCounts?.preimplementation_checklist_gap_count || 0)
    && asArray(dryCheck.noop_dry_check_items).length === Number(contract.expectedCounts?.noop_dry_check_item_count || 0)
    && asArray(dryCheck.blocked_future_slices).length === Number(contract.expectedCounts?.blocked_future_slice_count || 0)
    && asArray(dryCheck.prerequisite_gap_matrix).every((item) => item.satisfied_now !== true && item.authorizes_runtime !== true)
    && asArray(dryCheck.readiness_gap_matrix).every((item) => item.satisfied_now !== true && item.authorizes_runtime !== true)
    && asArray(dryCheck.preimplementation_checklist_gaps).every((item) => item.satisfied_now !== true)
    && asArray(dryCheck.noop_dry_check_items).every((item) => item.authorizes_kill_switch_wiring !== true)
    && asArray(dryCheck.blocked_future_slices).every((item) => item.implementation_allowed_now !== true);
}

function validationReportIdentityOk(report = {}, contract = {}) {
  return report.schema === (contract.expectedOutputShape?.reportSchema || VALIDATION_REPORT_SCHEMA_VERSION)
    && report.fixture_path === FIXTURE_REF
    && report.baseline_commit === BASELINE_COMMIT
    && report.version === KILL_SWITCH_WIRING_READINESS_ROLLUP_THROUGH_PHASE65_VERSION;
}

function checkMap(dryCheck = {}, contract = {}, report = null) {
  const syntheticReport = report || {
    schema: contract.expectedOutputShape?.reportSchema || VALIDATION_REPORT_SCHEMA_VERSION,
    fixture_path: FIXTURE_REF,
    baseline_commit: BASELINE_COMMIT,
    version: KILL_SWITCH_WIRING_READINESS_ROLLUP_THROUGH_PHASE65_VERSION,
    scoped_status: {
      only_fixture_changed_before_builder: true,
      [CURRENT_SCOPED_STATUS_KEY]: true,
      unrelated_files_untouched: true,
    },
  };
  const outputFieldsOk = hasRequiredFields(dryCheck, contract.expectedManifestShape?.requiredFields || REQUIRED_DRY_CHECK_FIELDS);
  const idempotencyOk = dryCheck.idempotency_key === killSwitchWiringReadinessRollupThroughPhase65IdempotencyKey(dryCheck);
  const literalOk = literalValuesOk(dryCheck, contract.expectedManifestShape?.requiredLiteralValues || {});
  const countBindingOk = countsOk(dryCheck, contract);
  const sourceBindingOk = sourceRefsOk(dryCheck, contract);
  const readinessOk = readinessRollupOk(dryCheck, contract);
  const phase63SummaryOk = phase63ReadinessRollupSummaryOk(dryCheck, contract);
  const phase63ScopedOk = phase63ScopedClosureOk(dryCheck);
  const phase64SummaryOk = phase64ReadinessRollupSummaryOk(dryCheck, contract);
  const phase64ScopedOk = phase64ScopedClosureOk(dryCheck);
  const phase64ManifestSchemaOk = phase64ManifestSchemaClosureOk(dryCheck);
  const duplicateOk = duplicateRegistryClosureOk(dryCheck, contract);
  const phase22Ok = phase22CaveatOk(dryCheck);
  const summariesBound = summariesOk(dryCheck, contract);
  const boundaryOk = boundaryAndCapabilityOk(dryCheck, contract);
  const noHybrid = hybridArtifactAbsent(dryCheck);
  const unsafeOk = unsafeActionDriftOk(dryCheck, contract);
  const scopedOk = scopedStatusOk(syntheticReport.scoped_status);
  const identityOk = validationReportIdentityOk(syntheticReport, contract);
  const noForbidden = (() => {
    try {
      assertNoForbiddenOutput(dryCheck, asArray(contract.forbiddenOutputSubstrings));
      return true;
    } catch {
      return false;
    }
  })();
  const genericOk = outputFieldsOk
    && idempotencyOk
    && literalOk
    && countBindingOk
    && sourceBindingOk
    && readinessOk
    && summariesBound
    && boundaryOk
    && noHybrid
    && unsafeOk
    && phase22Ok
    && noForbidden;

  const allIds = [
    ...asArray(contract.staticValidationRules).map((rule) => rule.id),
    ...asArray(contract.acceptanceChecks).map((check) => check.id),
  ];
  return allIds.reduce((acc, id) => {
    let ok = genericOk;
    if (/report-identity-current/.test(id)) ok = identityOk;
    if (/source-refs/.test(id)) ok = sourceBindingOk;
    if (/unsafe-action|next-recs/.test(id)) ok = unsafeOk;
    if (/forbidden/.test(id)) ok = noForbidden;
    if (/current-scoped-status-key-required|scoped-status-policy/.test(id)) ok = scopedOk;
    if (/stale-prior-scoped-keys-rejected/.test(id)) ok = scopedOk;
    if (/duplicate-registry-count/.test(id)) ok = duplicateOk;
    if (/phase63-readiness-rollup-current/.test(id)) ok = phase63SummaryOk;
    if (/phase63-scoped-status-closure-carried/.test(id)) ok = phase63ScopedOk;
    if (/phase64-readiness-rollup-current/.test(id)) ok = phase64SummaryOk;
    if (/phase64-scoped-status-policy-carried-as-prior-closure/.test(id)) ok = phase64ScopedOk;
    if (/phase64-scoped-status-closure-carried/.test(id)) ok = phase64ScopedOk;
    if (/phase64-manifest-schema-consistency-closure-carried/.test(id)) ok = phase64ManifestSchemaOk;
    if (/phase22-caveat/.test(id)) ok = phase22Ok;
    if (/hybrid-artifact/.test(id)) ok = noHybrid;
    if (/side-effect|capability|proof|boundary|gap|noop|runtime-mode|flag|kill/.test(id)) ok = boundaryOk && noForbidden;
    if (/registry|commit-chain|baseline|literal|shape/.test(id)
      && !/manifest-schema-consistency/.test(id)) ok = literalOk && countBindingOk;
    if (/readiness-rollup-through-phase63-contract-only|readiness-rollup-through-phase63-non-authorizing/.test(id)) {
      ok = readinessOk && phase63SummaryOk && phase22Ok;
    }
    if (/readiness-rollup-through-phase64-contract-only|readiness-rollup-through-phase64-non-authorizing/.test(id)) {
      ok = readinessOk && phase64SummaryOk && phase22Ok;
    }
    acc[id] = ok === true;
    return acc;
  }, {
    'output-shape-complete': outputFieldsOk,
    'required-literal-checks-bound': literalOk,
    'refresh-contract-complete': genericOk,
    'referenced-path-results-complete': true,
    'validation-report-coverage-bound': true,
  });
}

function validateDryCheck(dryCheck = {}, contract = {}, report = null) {
  const checks = [];
  const errors = [];
  const add = (id, ok) => {
    const result = resultObject(id, ok);
    checks.push(result);
    if (!ok) errors.push(id);
  };

  const ids = checkMap(dryCheck, contract, report);
  const outputShapeOk = dryCheck.schema === (contract.expectedManifestShape?.requiredLiteralValues?.schema
    || contract.expectedOutputShape?.manifestSchema
    || KILL_SWITCH_WIRING_READINESS_ROLLUP_THROUGH_PHASE65_SCHEMA_VERSION)
    && hasRequiredFields(dryCheck, contract.expectedManifestShape?.requiredFields || REQUIRED_DRY_CHECK_FIELDS);
  add('output-shape-complete', outputShapeOk);
  for (const rule of asArray(contract.staticValidationRules)) add(rule.id, ids[rule.id] === true);
  for (const check of asArray(contract.acceptanceChecks)) add(check.id, ids[check.id] === true);
  add('required-literal-checks-bound', ids['required-literal-checks-bound'] === true);
  add('refresh-contract-complete',
    outputShapeOk
      && asArray(contract.staticValidationRules).every((rule) => ids[rule.id] === true)
      && asArray(contract.acceptanceChecks).every((check) => ids[check.id] === true)
      && ids['required-literal-checks-bound'] === true);

  const resultById = checks.reduce((acc, check) => {
    acc[check.id] = check;
    return acc;
  }, {});
  return {
    ok: errors.length === 0,
    checks,
    errors,
    resultById,
  };
}

function buildValidationReport(dryCheck, contract = {}, generatedAt = dryCheck.generated_at) {
  const validation = validateDryCheck(dryCheck, contract);
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
  const literalReportValues = validationReportLiteralValues(contract);
  const report = {
    schema: literalReportValues.schema,
    version: literalReportValues.version,
    validation_report_id: `kill-switch-wiring-readiness-rollup-through-phase64-validation-${stableHash({
      rollup_key: dryCheck.idempotency_key,
      generatedAt,
    }).slice(0, 12)}`,
    fixture_path: FIXTURE_REF,
    generated_at: generatedAt,
    baseline_commit: BASELINE_COMMIT,
    decision: validation.ok ? 'accepted_validation_only' : 'rejected',
    status: literalReportValues.status,
    static_rule_min_count: literalReportValues.static_rule_min_count,
    acceptance_check_min_count: literalReportValues.acceptance_check_min_count,
    tamper_case_min_count: literalReportValues.tamper_case_min_count,
    required_literal_min_count: literalReportValues.required_literal_min_count,
    static_rule_results: staticResults,
    acceptance_check_results: acceptanceResults,
    tamper_case_results: tamperResults,
    required_literal_results: requiredLiteralResults(dryCheck, contract.expectedManifestShape?.requiredLiteralValues || {}),
    referenced_path_results: buildReferencedPathResults(contract),
    forbidden_output_scan: resultObject('forbidden-output-strings-absent',
      validation.resultById['static-forbidden-output-scan']?.ok !== false),
    unsafe_action_scan: resultObject('unsafe-action-drift-rejected',
      validation.resultById['static-unsafe-action-policy']?.ok !== false),
    side_effect_truth: literalReportValues.side_effect_truth,
    scoped_status: literalReportValues.scoped_status,
    diff_check: literalReportValues.diff_check,
    caveats: [],
    summary: {
      current_through_phase: dryCheck.phase_registry?.current_through_phase,
      phase_registry_count: dryCheck.phase_registry?.phase_inventory_count,
      schema_registry_count: dryCheck.schema_registry?.count,
      cli_registry_count: dryCheck.cli_registry?.count,
      duplicate_schema_registry_count: dryCheck.phase_registry?.schema_registry_count,
      duplicate_cli_registry_count: dryCheck.phase_registry?.cli_registry_count,
      commit_chain_count: asArray(dryCheck.commit_chain).length,
      source_ref_count: asArray(dryCheck.source_refs).length,
      source_contract_count: asArray(contract.sourceContracts).length,
      readiness_rollup_current_through_phase: dryCheck.readiness_rollup_summary?.current_through_phase,
      phase64_validation_green: dryCheck.phase64_readiness_rollup_summary?.validation_green,
      current_scoped_status_key: CURRENT_SCOPED_STATUS_KEY,
      accepted_validation_only: validation.ok,
    },
  };
  assertNoForbiddenOutput(report, asArray(contract.forbiddenOutputSubstrings));
  return report;
}

function buildMiraCoreKillSwitchWiringReadinessRollupThroughPhase65(options = {}) {
  const contract = options.contract || {};
  const dryCheck = buildDryCheck(options);
  const validation_report = buildValidationReport(dryCheck, contract, dryCheck.generated_at);
  const output = { [OUTPUT_FIELD]: dryCheck, validation_report };
  assertNoForbiddenOutput(output, asArray(contract.forbiddenOutputSubstrings));
  return output;
}

function validateMiraCoreKillSwitchWiringReadinessRollupThroughPhase65Output(output = {}, contract = {}) {
  const checks = [];
  const errors = [];
  const add = (id, ok) => {
    checks.push({ id, ok: ok === true });
    if (!ok) errors.push(id);
  };
  const dryCheck = output[OUTPUT_FIELD] || {};
  const report = output.validation_report || {};
  const dryCheckValidation = validateDryCheck(dryCheck, contract, report);
  const referencedOk = referencedPathResultsOk(report.referenced_path_results, contract);
  const recomputedById = dryCheckValidation.checks.reduce((acc, check) => {
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
    && literalResultsOk(report.required_literal_results, dryCheck, contract)
    && referencedOk;

  add('output-shape-complete',
    hasRequiredFields(output, contract.expectedOutputShape?.requiredTopLevelFields || REQUIRED_OUTPUT_FIELDS)
      && dryCheck.schema === (contract.expectedManifestShape?.requiredLiteralValues?.schema
        || contract.expectedOutputShape?.manifestSchema
        || KILL_SWITCH_WIRING_READINESS_ROLLUP_THROUGH_PHASE65_SCHEMA_VERSION)
      && report.schema === (contract.expectedOutputShape?.reportSchema || VALIDATION_REPORT_SCHEMA_VERSION)
      && hasRequiredFields(dryCheck, contract.expectedManifestShape?.requiredFields || REQUIRED_DRY_CHECK_FIELDS)
      && hasRequiredFields(report, contract.expectedValidationReportShape?.requiredFields || REQUIRED_VALIDATION_REPORT_FIELDS));

  for (const check of dryCheckValidation.checks) add(check.id, check.ok);

  add('validation-report-literal-values',
    validationReportIdentityOk(report, contract)
      && literalValuesOk(report, contract.expectedValidationReportShape?.requiredLiteralValues || {}));
  add('validation-report-side-effect-truth', sideEffectValuesOk(report.side_effect_truth, contract));
  add('validation-report-scoped-status-current', scopedStatusOk(report.scoped_status));
  add('referenced-path-results-complete', referencedOk);
  add('validation-report-coverage-bound', reportCoverageOk);
  add('validation-report-matches-contract',
    report.decision === (dryCheckValidation.ok ? 'accepted_validation_only' : 'rejected')
      && report.status === (contract.expectedValidationReportShape?.requiredLiteralValues?.status
        || 'fixture_contract_only_no_runtime_side_effects')
      && scopedStatusOk(report.scoped_status)
      && reportCoverageOk
      && report.forbidden_output_scan?.ok === Boolean(recomputedById['static-forbidden-output-scan']?.ok !== false)
      && report.unsafe_action_scan?.ok === Boolean(recomputedById['static-unsafe-action-policy']?.ok !== false));

  try {
    assertNoForbiddenOutput(output, asArray(contract.forbiddenOutputSubstrings));
    add('forbidden-output-strings-absent', true);
  } catch {
    add('forbidden-output-strings-absent', false);
  }

  return { ok: errors.length === 0, checks, errors };
}

module.exports = {
  BASELINE_COMMIT,
  CURRENT_SCOPED_STATUS_KEY,
  STALE_SCOPED_STATUS_KEYS,
  REQUIRED_OUTPUT_FIELDS,
  REQUIRED_DRY_CHECK_FIELDS,
  REQUIRED_VALIDATION_REPORT_FIELDS,
  KILL_SWITCH_WIRING_READINESS_ROLLUP_THROUGH_PHASE65_SCHEMA_VERSION,
  VALIDATION_REPORT_SCHEMA_VERSION,
  assertNoForbiddenOutput,
  buildMiraCoreKillSwitchWiringReadinessRollupThroughPhase65,
  killSwitchWiringReadinessRollupThroughPhase65IdempotencyKey,
  stableHash,
  validateMiraCoreKillSwitchWiringReadinessRollupThroughPhase65Output,
};
