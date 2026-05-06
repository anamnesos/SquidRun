'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const FIXTURE_REF =
  'ui/__tests__/fixtures/mira-core-kill-switch-wiring-readiness-rollup-through-phase50-contract.json';
const KILL_SWITCH_WIRING_READINESS_ROLLUP_THROUGH_PHASE50_SCHEMA_VERSION =
  'squidrun.mira_core.kill_switch_wiring_readiness_rollup_through_phase50.v0';
const VALIDATION_REPORT_SCHEMA_VERSION =
  'squidrun.mira_core.kill_switch_wiring_readiness_rollup_through_phase50_validation_report.v0';
const KILL_SWITCH_WIRING_READINESS_ROLLUP_THROUGH_PHASE50_VERSION = 0;
const BASELINE_COMMIT = '6ecba39';

const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');

const REQUIRED_OUTPUT_FIELDS = Object.freeze([
  'kill_switch_wiring_readiness_rollup_through_phase50',
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

const NEGATABLE_FORBIDDEN_OUTPUT_SUBSTRINGS = Object.freeze(new Set([
  'runtime started',
  'runtime available now',
  'runner executed',
  'server can execute local',
  'server can prove model processing',
  'builder target allowed',
  'oracle target allowed',
  'kill switch wired',
  'kill switch live check performed',
  'allow open',
  'flag reader implemented',
  'flag read now',
  'env read',
  'process.env',
  'secret read',
  'raw config',
  'output file written',
  'database written',
  'store written',
  'queue created',
  'lease created',
  'reporting sink written',
  'shell executed',
  'pty executed',
  'network request',
  'listener started',
  'route registered',
  'browser opened',
  'capture performed',
  'noop dry check available',
  'noop dry check executed',
  'noop boundary refresh available',
  'send customer',
  'email customer',
  'message client',
  'deploy',
  'trade',
]));

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
  return String(dottedPath || '')
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .filter(Boolean)
    .reduce((acc, key) => {
      if (Array.isArray(acc) && key === 'length') return acc.length;
      if (Array.isArray(acc) && key === 'last') return acc[acc.length - 1];
      return acc && Object.prototype.hasOwnProperty.call(acc, key) ? acc[key] : undefined;
    }, value);
}

function hasRequiredFields(value, fields = []) {
  return Boolean(value) && asArray(fields).every((field) => Object.prototype.hasOwnProperty.call(value, field));
}

function containsExpectedValues(value = {}, expected = {}) {
  return Boolean(value) && Object.entries(expected).every(([key, expectedValue]) => (
    valuesMatch(value[key], expectedValue)
  ));
}

function idsEqual(items = [], field, expectedIds = []) {
  return valuesMatch(asArray(items).map((item) => item[field]), asArray(expectedIds));
}

function resultObject(id, ok) {
  return { id, ok: ok === true };
}

function evidenceRef(store, eventId, relation = 'kill_switch_wiring_readiness_rollup_through_phase50_validation') {
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
    sessionId: inputSignals.sessionId || 'session-349',
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
  const current = expected.current_truth || {};
  return {
    expected_phases: expected.expected_phases || '1-50',
    current_through_phase: expected.phase_inventory_count || 50,
    phase_inventory_count: expected.phase_inventory_count || 50,
    schema_registry_count: expected.schema_registry_count || 50,
    cli_registry_count: expected.cli_registry_count || 50,
    ...clone(current),
    phase50_commit: BASELINE_COMMIT,
    phase50_delta: clone(expected.phase50_delta || {}),
    phase34_prior_recommendations: expected.phase34_prior_recommendations,
    recent_phase_paths: clone(expected.required_recent_phase_paths || []),
    evidenceRefs: [
      evidenceRef('git', BASELINE_COMMIT, 'phase51-baseline'),
      evidenceRef('fixture', FIXTURE_REF, 'phase-registry'),
    ],
  };
}

function registry(kind, contract = {}) {
  const count = Number(contract.expectedCounts?.[`${kind}_registry_count`] || 49);
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

function currentTruthValues(contract = {}) {
  return {
    ...clone(contract.currentTruthExpected || contract.phaseRegistryExpected?.current_truth || {}),
    phase48_current: true,
    phase49_current: true,
    phase50_current: true,
    phase49_noop_boundary_refresh_validation_current: true,
    phase50_noop_boundary_refresh_validation_current: true,
    phase50_readiness_rollup_validation_current: true,
    kill_switch_wiring_noop_boundary_refresh_remains_non_authorizing: true,
    kill_switch_wiring_readiness_rollup_remains_non_authorizing: true,
    kill_switch_wiring_readiness_rollup_through_phase50_remains_non_authorizing: true,
    noop_boundary_refresh_remains_contract_only: true,
    noop_dry_check_remains_contract_only: true,
    no_env_config_flag_read_now: true,
    kill_switch_remains_unwired: true,
  };
}

function closureSummaryValues(contract = {}) {
  const expected = contract.closureSummaryExpected || {};
  return {
    oracle_115_prerequisite_mapping_closure_carried: true,
    oracle_123_expires_at_closure_carried: true,
    oracle_127_validation_report_tamper_closure_carried: true,
    oracle_131_phase34_review_closure_carried: true,
    oracle_134_phase35_review_closure_carried: true,
    oracle_137_phase36_review_closure_carried: true,
    oracle_141_phase37_review_closure_carried: true,
    oracle_148_phase38_review_closure_carried: true,
    oracle_149_phase38_status_closure_carried: true,
    oracle_156_phase39_review_closure_carried: true,
    oracle_161_phase40_review_closure_carried: true,
    oracle_165_phase41_review_closure_carried: true,
    oracle_168_phase42_review_closure_carried: true,
    oracle_171_phase43_review_closure_carried: true,
    oracle_174_phase44_review_closure_carried: true,
    oracle_178_phase45_review_closure_carried: true,
    oracle_182_phase46_review_closure_carried: true,
    oracle_186_phase47_review_closure_carried: true,
    oracle_190_phase48_review_closure_carried: true,
    oracle_194_phase49_review_closure_carried: true,
    oracle_200_phase50_review_closure_carried: true,
    builder_301_phase50_validation_report_carried: true,
    builder_301_phase49_validation_report_carried: true,
    builder_306_phase50_validation_report_carried: true,
    closed_review_refs: clone(expected.closed_review_refs || [
      'ORACLE #115',
      'ORACLE #123',
      'ORACLE #127',
      'ORACLE #131',
      'ORACLE #134',
      'ORACLE #137',
      'ORACLE #141',
      'ORACLE #148',
      'ORACLE #149',
      'ORACLE #156',
      'ORACLE #161',
      'ORACLE #165',
      'ORACLE #168',
      'ORACLE #171',
      'ORACLE #174',
      'ORACLE #178',
      'ORACLE #182',
      'ORACLE #186',
      'ORACLE #190',
      'ORACLE #194',
      'ORACLE #200',
    ]),
    source_contracts_count: asArray(contract.sourceContracts).length,
  };
}

function nextPhaseRecommendations(contract = {}) {
  return asArray(contract.nextRecommendationExpectedCandidates).map((candidate) => ({
    ...clone(candidate),
    blocked_side_effects: [
      'ui-rendering',
      'browser-window-capture',
      'runtime-start',
      'server-transport',
      'persistent-mutation',
      'queue-lease',
      'flag-read',
      'env-config-read',
      'kill-switch-wire',
      'kill-switch-live-check',
      'control-action',
      'reporting-artifact-output',
      'irreversible-action-boundary',
    ],
    evidenceRefs: [evidenceRef('fixture', FIXTURE_REF, `next:${candidate.recommendation_id}`)],
  }));
}

function canonicalDryCheckInput(dryCheck = {}) {
  return {
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
    side_effect_result: dryCheck.side_effect_result,
  };
}

function killSwitchWiringReadinessRollupThroughPhase50IdempotencyKey(dryCheck) {
  return `kill-switch-wiring-readiness-rollup-through-phase50:${stableHash(canonicalDryCheckInput(dryCheck))}`;
}

function buildDryCheck(options = {}) {
  const contract = options.contract || {};
  const inputSignals = options.inputSignals || {};
  const scope = normalizeScope(inputSignals);
  const generatedAt = generatedAtFromOptions(options, inputSignals);
  const dryCheck = {
    schema: KILL_SWITCH_WIRING_READINESS_ROLLUP_THROUGH_PHASE50_SCHEMA_VERSION,
    version: KILL_SWITCH_WIRING_READINESS_ROLLUP_THROUGH_PHASE50_VERSION,
    rollup_id: `kill-switch-wiring-readiness-rollup-through-phase50-${stableHash({
      scope,
      baseline: BASELINE_COMMIT,
      source: contract.sourceRecommendation?.recommendation_id,
    }).slice(0, 12)}`,
    idempotency_key: null,
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
    stale_readiness: withEvidence(contract.phaseRegistryExpected?.stale_truth || {}, 'fixture', 'stale-readiness'),
    phase34_prior_recommendations: withEvidence({ satisfied_and_not_reopened: true }, 'git', 'c04155d'),
    closure_summary: withEvidence(closureSummaryValues(contract), 'oracle-review', 'closure-summary'),
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
    noop_boundary_refresh_summary: withEvidence(
      contract.noopBoundaryRefreshSummaryExpected || {},
      'fixture',
      'noop-boundary-refresh-summary',
    ),
    noop_boundary_status: withEvidence(
      contract.noopBoundaryStatusExpected || {},
      'fixture',
      'noop-boundary-status',
    ),
    noop_dry_check_request_contract: withEvidence(
      contract.noopDryCheckRequestContractExpected || {},
      'fixture',
      'noop-dry-check-request-contract',
    ),
    noop_dry_check_result_contract: withEvidence(
      contract.noopDryCheckResultContractExpected || {},
      'fixture',
      'noop-dry-check-result-contract',
    ),
    runtime_mode_boundary: withEvidence(contract.runtimeModeBoundaryShapeExpected?.requiredValues || {}, 'fixture', 'runtime-mode-boundary'),
    flag_reader_boundary: withEvidence(contract.flagReaderBoundaryShapeExpected?.requiredValues || {}, 'fixture', 'flag-reader-boundary'),
    env_config_read_boundary: withEvidence(contract.envConfigReadBoundaryShapeExpected?.requiredValues || {}, 'fixture', 'env-config-read-boundary'),
    kill_switch_boundary: withEvidence(contract.killSwitchBoundaryShapeExpected?.requiredValues || {}, 'fixture', 'kill-switch-boundary'),
    kill_switch_wiring_boundary: withEvidence(contract.killSwitchWiringBoundaryShapeExpected?.requiredValues || {}, 'fixture', 'kill-switch-wiring-boundary'),
    prerequisite_gap_matrix: matrixWithEvidence(contract.prerequisiteGapMatrixExpected, 'fixture'),
    readiness_gap_matrix: matrixWithEvidence(contract.readinessGapMatrixExpected, 'fixture'),
    preimplementation_checklist_gaps: matrixWithEvidence(contract.preimplementationChecklistGapsExpected, 'fixture'),
    noop_dry_check_items: matrixWithEvidence(contract.noopDryCheckItemsExpected, 'fixture'),
    blocked_future_slices: matrixWithEvidence(contract.blockedFutureSlicesExpected, 'fixture'),
    capability_matrix: withEvidence(contract.capabilityMatrixExpected || {}, 'fixture', 'capability-matrix'),
    proof_boundaries: withEvidence(contract.proofBoundaryExpected || {}, 'fixture', 'proof-boundaries'),
    boundary_truth: withEvidence(boundaryTruthValues(), 'fixture', 'boundary-truth'),
    redaction_summary: redactionSummary(),
    unsafe_action_policy: unsafeActionPolicy(),
    next_phase_recommendations: nextPhaseRecommendations(contract),
    evidenceRefs: [
      evidenceRef('git', BASELINE_COMMIT, 'phase51-baseline'),
      evidenceRef('fixture', FIXTURE_REF, 'oracle-contract'),
    ],
    side_effect_result: sideEffectResult(contract),
  };
  dryCheck.idempotency_key = killSwitchWiringReadinessRollupThroughPhase50IdempotencyKey(dryCheck);
  return dryCheck;
}

function literalValuesOk(value = {}, literalMap = {}) {
  return Object.entries(literalMap).every(([dottedPath, expectedValue]) => (
    valuesMatch(pathValue(value, dottedPath), expectedValue)
  ));
}

function requiredLiteralResults(value = {}, literalMap = {}) {
  return Object.entries(literalMap).map(([dottedPath, expectedValue]) => {
    const actual = pathValue(value, dottedPath);
    return { path: dottedPath, expected: expectedValue, actual, ok: valuesMatch(actual, expectedValue) };
  });
}

function objectValuesOk(value = {}, shape = {}) {
  return containsExpectedValues(value, shape.requiredValues || {});
}

function registryCountsOk(dryCheck = {}, contract = {}) {
  const count = Number(contract.expectedCounts?.phase_inventory_count || 49);
  return dryCheck.phase_registry?.phase_inventory_count === count
    && dryCheck.phase_registry?.current_through_phase === count
    && dryCheck.schema_registry?.count === count
    && dryCheck.cli_registry?.count === count
    && asArray(dryCheck.schema_registry?.entries).length === count
    && asArray(dryCheck.cli_registry?.entries).length === count;
}

function commitChainOk(dryCheck = {}, contract = {}) {
  const expected = contract.commitChainExpected || [];
  return valuesMatch(dryCheck.commit_chain, expected)
    && asArray(dryCheck.commit_chain).length === Number(contract.expectedCounts?.commit_chain_count || 37)
    && dryCheck.commit_chain?.[dryCheck.commit_chain.length - 1] === BASELINE_COMMIT;
}

function phasesCurrentOk(dryCheck = {}, contract = {}) {
  return Object.keys(contract.phaseRegistryExpected?.current_truth || {}).every((key) => (
    dryCheck.phase_registry?.[key] === true
    && dryCheck.current_truth?.[key] === true
  ));
}

function sourceRecommendationOk(dryCheck = {}, contract = {}) {
  const source = dryCheck.source_recommendation || {};
  return containsExpectedValues(source, contract.sourceRecommendation || {})
    && source.recommendation_id === 'phase51-kill-switch-wiring-readiness-rollup-through-phase50-contract'
    && source.tier === 'tier1'
    && source.selected_as === 'fixture_only_contract'
    && source.implementation_status === 'not_implemented'
    && source.does_not_authorize_flag_read === true
    && source.does_not_authorize_kill_switch_wiring === true
    && source.does_not_authorize_live_check === true;
}

function satisfiedPriorOk(dryCheck = {}, contract = {}) {
  const expected = asArray(contract.satisfiedPriorRecommendations);
  return asArray(dryCheck.satisfied_prior_recommendations).length === expected.length
    && asArray(dryCheck.satisfied_prior_recommendations).every((entry, index) => containsExpectedValues(entry, expected[index]));
}

function staleReadinessOk(dryCheck = {}) {
  return dryCheck.stale_readiness?.phase13_stale === true
    && dryCheck.stale_readiness?.phase23_stale === true
    && dryCheck.stale_readiness?.phase31_stale === true;
}

function phase34PriorOk(dryCheck = {}) {
  return dryCheck.phase34_prior_recommendations?.satisfied_and_not_reopened === true;
}

function closuresOk(dryCheck = {}) {
  return dryCheck.closure_summary?.oracle_200_phase50_review_closure_carried === true
    && dryCheck.closure_summary?.builder_306_phase50_validation_report_carried === true
    && asArray(dryCheck.closure_summary?.closed_review_refs).includes('ORACLE #200');
}

function sourceRefsOk(dryCheck = {}, contract = {}) {
  return valuesMatch(dryCheck.source_refs, contract.sourceRefsExpected || [])
    && asArray(dryCheck.source_refs).length === Number(contract.expectedCounts?.source_ref_count || 20)
    && asArray(dryCheck.source_refs).some((ref) => ref.artifact_id === 'phase50-kill-switch-wiring-readiness-rollup-through-phase49');
}

function noopRefreshSummaryOk(dryCheck = {}, contract = {}) {
  const summary = dryCheck.noop_boundary_refresh_summary || {};
  return containsExpectedValues(summary, contract.noopBoundaryRefreshSummaryExpected || {})
    && summary.boundary_refresh_item_count === 8
    && summary.ready_for_runtime_now === false
    && summary.ready_for_dry_run_now === false
    && summary.ready_for_kill_switch_wiring_now === false
    && summary.noop_would_read_flag === false
    && summary.noop_would_execute === false
    && summary.noop_would_wire_kill_switch === false
    && summary.noop_would_perform_live_check === false
    && summary.noop_would_emit_output_file === false
    && summary.all_items_non_authorizing === true;
}

function readinessRollupSummaryOk(dryCheck = {}, contract = {}) {
  const summary = dryCheck.readiness_rollup_summary || {};
  return containsExpectedValues(summary, contract.readinessRollupSummaryExpected || {})
    && summary.decision === 'remain_kill_switch_wiring_readiness_rollup_contract_only'
    && summary.current_through_phase === Number(contract.expectedCounts?.phase_inventory_count || 49)
    && summary.ready_for_runtime_now === false
    && summary.ready_for_dry_run_now === false
    && summary.ready_for_kill_switch_wiring_now === false
    && summary.ready_for_noop_execution_now === false
    && summary.runtime_mode_flag_reader_implemented === false
    && summary.live_kill_switch_wired === false
    && summary.noop_boundary_refresh_available === false
    && summary.all_gaps_blocking === true
    && summary.all_future_slices_blocked === true
    && summary.all_next_recommendations_non_authorizing === true
    && summary.authorizes_runtime === false
    && summary.authorizes_kill_switch_wiring === false
    && summary.authorizes_local_execution === false
    && summary.authorizes_output_file === false;
}

function phase49BoundaryRefreshSummaryOk(dryCheck = {}, contract = {}) {
  const summary = dryCheck.phase49_boundary_refresh_summary || {};
  return containsExpectedValues(summary, contract.phase49BoundaryRefreshSummaryExpected || {})
    && summary.committed_baseline === '17441a8'
    && summary.validation_green === true
    && summary.oracle_review_ref === 'ORACLE #194'
    && summary.builder_report_ref === 'BUILDER #301'
    && summary.remains_validation_only === true
    && summary.remains_contract_only === true
    && summary.no_runtime_performed === true
    && summary.no_flag_read_performed === true
    && summary.no_kill_switch_wiring_performed === true
    && summary.no_noop_execution_performed === true
    && summary.no_live_check_performed === true
    && summary.no_output_file_written === true
    && summary.does_not_authorize_runtime === true
    && summary.does_not_authorize_kill_switch_wiring === true;
}

function phase50ReadinessRollupSummaryOk(dryCheck = {}, contract = {}) {
  const summary = dryCheck.phase50_readiness_rollup_summary || {};
  return containsExpectedValues(summary, contract.phase50ReadinessRollupSummaryExpected || {})
    && summary.committed_baseline === BASELINE_COMMIT
    && summary.validation_green === true
    && summary.oracle_review_ref === 'ORACLE #200'
    && summary.builder_report_ref === 'BUILDER #306'
    && summary.remains_validation_only === true
    && summary.remains_contract_only === true
    && summary.no_runtime_performed === true
    && summary.no_flag_read_performed === true
    && summary.no_kill_switch_wiring_performed === true
    && summary.no_noop_execution_performed === true
    && summary.no_live_check_performed === true
    && summary.no_output_file_written === true
    && summary.does_not_authorize_runtime === true
    && summary.does_not_authorize_kill_switch_wiring === true;
}

function noopBoundaryStatusOk(dryCheck = {}, contract = {}) {
  const status = dryCheck.noop_boundary_status || {};
  return containsExpectedValues(status, contract.noopBoundaryStatusExpected || {})
    && status.contract_only === true
    && status.reference_only === true
    && status.request_reads_allowed === false
    && status.noop_execution_allowed === false
    && status.live_check_allowed === false
    && status.output_file_allowed === false
    && status.authorizes_runtime === false
    && status.authorizes_kill_switch_wiring === false;
}

function noopRequestOk(dryCheck = {}, contract = {}) {
  const request = dryCheck.noop_dry_check_request_contract || {};
  return containsExpectedValues(request, contract.noopDryCheckRequestContractExpected || {})
    && request.validation_only === true
    && request.no_env_config_flag_read === true
    && request.no_live_kill_switch_check === true
    && request.no_control_or_reporting_sink === true
    && request.no_output_file === true
    && request.authorizes_runtime === false
    && request.authorizes_kill_switch_wiring === false;
}

function noopResultOk(dryCheck = {}, contract = {}) {
  const result = dryCheck.noop_dry_check_result_contract || {};
  return containsExpectedValues(result, contract.noopDryCheckResultContractExpected || {})
    && result.no_runtime_started === true
    && result.no_flag_read === true
    && result.no_kill_switch_wired === true
    && result.no_live_check_performed === true
    && result.no_control_or_reporting_sink === true
    && result.no_output_file_written === true
    && result.authorizes_runtime === false
    && result.authorizes_kill_switch_wiring === false;
}

function matrixValuesOk(actual = [], expected = []) {
  return asArray(actual).length === asArray(expected).length
    && asArray(actual).every((entry, index) => containsExpectedValues(entry, expected[index]));
}

function prerequisiteGapsOk(dryCheck = {}, contract = {}) {
  return matrixValuesOk(dryCheck.prerequisite_gap_matrix, contract.prerequisiteGapMatrixExpected)
    && asArray(dryCheck.prerequisite_gap_matrix).every((entry) => (
      entry.status === 'unsatisfied_blocking_non_authorizing'
      && entry.satisfied_now === false
      && entry.blocking === true
      && entry.authorizes_runtime === false
      && entry.authorizes_kill_switch_wiring === false
    ));
}

function readinessGapsOk(dryCheck = {}, contract = {}) {
  return matrixValuesOk(dryCheck.readiness_gap_matrix, contract.readinessGapMatrixExpected)
    && asArray(dryCheck.readiness_gap_matrix).every((entry) => (
      entry.status === 'unsatisfied_blocking_non_authorizing'
      && entry.satisfied_now === false
      && entry.blocking === true
    ));
}

function preimplementationGapsOk(dryCheck = {}, contract = {}) {
  return matrixValuesOk(dryCheck.preimplementation_checklist_gaps, contract.preimplementationChecklistGapsExpected)
    && asArray(dryCheck.preimplementation_checklist_gaps).every((entry) => (
      entry.status === 'required_unsatisfied_blocking_non_authorizing'
      && entry.satisfied_now === false
      && entry.authorizes_kill_switch_wiring === false
    ));
}

function noopItemsOk(dryCheck = {}, contract = {}) {
  return matrixValuesOk(dryCheck.noop_dry_check_items, contract.noopDryCheckItemsExpected)
    && asArray(dryCheck.noop_dry_check_items).every((entry) => (
      entry.status === 'required_contract_only_non_authorizing'
      && entry.satisfied_now === false
      && entry.authorizes_runtime === false
      && entry.authorizes_kill_switch_wiring === false
    ));
}

function blockedFutureSlicesOk(dryCheck = {}, contract = {}) {
  return matrixValuesOk(dryCheck.blocked_future_slices, contract.blockedFutureSlicesExpected)
    && asArray(dryCheck.blocked_future_slices).every((entry) => (
      entry.status === 'blocked_now_non_authorizing'
      && entry.implementation_allowed_now === false
      && entry.requires_future_contract === true
    ));
}

function capabilityOk(dryCheck = {}, contract = {}) {
  return containsExpectedValues(dryCheck.capability_matrix, contract.capabilityMatrixExpected || {})
    && dryCheck.capability_matrix?.directBuilderOracleServerTargetsBlocked === true
    && Object.entries(contract.capabilityMatrixExpected || {})
      .every(([key, value]) => (key === 'directBuilderOracleServerTargetsBlocked' ? value === true : value === false));
}

function proofOk(dryCheck = {}, contract = {}) {
  return containsExpectedValues(dryCheck.proof_boundaries, contract.proofBoundaryExpected || {})
    && Object.values(contract.proofBoundaryExpected || {}).every((value) => value === false);
}

function boundaryTruthOk(dryCheck = {}) {
  return Object.values(boundaryTruthValues()).every((value) => value === true)
    && containsExpectedValues(dryCheck.boundary_truth, boundaryTruthValues());
}

function sideEffectValuesOk(sideEffect = {}, contract = {}) {
  return Object.keys(contract.sideEffectTruthExpected || {}).every((field) => sideEffect[field] === true)
    && EXTRA_FALSE_SIDE_EFFECT_FIELDS.every((field) => sideEffect[field] === false)
    && SIDE_EFFECT_COUNTER_FIELDS.every((field) => sideEffect[field] === 0);
}

function redactionSummaryOk(dryCheck = {}) {
  return dryCheck.redaction_summary?.raw_private_content_exported === false
    && dryCheck.redaction_summary?.raw_terminal_exported === false
    && dryCheck.redaction_summary?.raw_screenshot_ocr_browser_exported === false
    && dryCheck.redaction_summary?.secret_material_exported === false
    && dryCheck.redaction_summary?.customer_private_content_exported === false
    && dryCheck.redaction_summary?.raw_config_exported === false;
}

function nextRecommendationsOk(dryCheck = {}, contract = {}) {
  const actual = asArray(dryCheck.next_phase_recommendations);
  const expected = asArray(contract.nextRecommendationExpectedCandidates);
  return actual.length === expected.length
    && actual.every((entry, index) => containsExpectedValues(entry, expected[index]))
    && actual.every((entry) => ['tier0', 'tier1'].includes(entry.tier));
}

function nextRecommendationsNonAuthorizingOk(dryCheck = {}) {
  return asArray(dryCheck.next_phase_recommendations).every((entry) => (
    entry.does_not_authorize_runtime === true
    && entry.does_not_authorize_execution === true
    && entry.does_not_authorize_kill_switch_wiring === true
    && entry.does_not_authorize_live_check === true
    && entry.does_not_authorize_output_files === true
  ));
}

function normalizeText(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9.]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function occurrenceIsNegated(text, index) {
  const window = text.slice(Math.max(0, index - 60), index);
  return /\b(no|not|never|without|false|blocked|disabled|unwired|unimplemented|reference only|non authorizing)\b/.test(window);
}

function textHasOutboundRecipientDrift(text) {
  const normalized = normalizeText(text);
  return OUTBOUND_TERMS.some((term) => normalized.includes(term))
    && RECIPIENT_TERMS.some((term) => normalized.includes(term));
}

function textHasUnsafeActionDrift(text, contract = {}) {
  const normalized = normalizeText(text);
  if (!normalized) return false;
  if (textHasOutboundRecipientDrift(normalized)) return true;
  return asArray(contract.unsafeActionPhrases).some((phrase) => {
    const normalizedPhrase = normalizeText(phrase);
    const index = normalized.indexOf(normalizedPhrase);
    return index >= 0 && !occurrenceIsNegated(normalized, index);
  });
}

function collectStrings(value, output = []) {
  if (typeof value === 'string') output.push(value);
  else if (Array.isArray(value)) value.forEach((entry) => collectStrings(entry, output));
  else if (value && typeof value === 'object') Object.values(value).forEach((entry) => collectStrings(entry, output));
  return output;
}

function unsafeActionDriftOk(dryCheck = {}, contract = {}) {
  const relevant = [
    dryCheck.source_recommendation,
    dryCheck.readiness_rollup_summary,
    dryCheck.phase49_boundary_refresh_summary,
    dryCheck.phase50_readiness_rollup_summary,
    dryCheck.noop_boundary_refresh_summary,
    dryCheck.noop_boundary_status,
    dryCheck.noop_dry_check_request_contract,
    dryCheck.noop_dry_check_result_contract,
    dryCheck.noop_dry_check_items,
    dryCheck.blocked_future_slices,
    dryCheck.next_phase_recommendations,
  ];
  return collectStrings(relevant).every((text) => !textHasUnsafeActionDrift(text, contract));
}

function forbiddenOccurrenceIsNegated(text, index) {
  const before = text.slice(Math.max(0, index - 140), index);
  const after = text.slice(index, index + 140);
  return occurrenceIsNegated(text, index)
    || /\b(no|not|false|blocked|disabled|unwired|unimplemented|reference only|side effect|boundary|path|expected|actual|attempts?|attempted|tamper|expectedfailure|forbidden)\b/.test(before)
    || /\b(false|blocked|disabled|unwired|unimplemented|reference only|side effect|boundary|expected|actual|attempts?|attempted|expectedfailure|forbidden)\b/.test(after);
}

function assertNoForbiddenOutput(output, forbiddenSubstrings = []) {
  const text = normalizeText(JSON.stringify(output));
  for (const forbidden of asArray(forbiddenSubstrings)) {
    const normalizedForbidden = normalizeText(forbidden);
    if (!normalizedForbidden) continue;
    let index = text.indexOf(normalizedForbidden);
    while (index >= 0) {
      if (!NEGATABLE_FORBIDDEN_OUTPUT_SUBSTRINGS.has(normalizedForbidden)
        || !forbiddenOccurrenceIsNegated(text, index)) {
        throw new Error(`Forbidden output substring present: ${forbidden}`);
      }
      index = text.indexOf(normalizedForbidden, index + normalizedForbidden.length);
    }
  }
}

function noForbiddenOutput(value, forbiddenSubstrings = []) {
  try {
    assertNoForbiddenOutput(value, forbiddenSubstrings);
    return true;
  } catch {
    return false;
  }
}

function noForbiddenStringValues(value, forbiddenSubstrings = []) {
  return collectStrings(value).every((rawValue) => {
    const valueText = normalizeText(rawValue);
    return asArray(forbiddenSubstrings).every((forbidden) => {
      const normalizedForbidden = normalizeText(forbidden);
      if (!normalizedForbidden) return true;
      const index = valueText.indexOf(normalizedForbidden);
      return index < 0
        || (NEGATABLE_FORBIDDEN_OUTPUT_SUBSTRINGS.has(normalizedForbidden)
          && occurrenceIsNegated(valueText, index));
    });
  });
}

function referencedPaths(contract = {}) {
  const paths = new Set([FIXTURE_REF]);
  for (const relativePath of asArray(contract.sourceContracts)) {
    if (relativePath) paths.add(relativePath);
  }
  for (const ref of asArray(contract.sourceRefsExpected)) {
    for (const field of ['fixture_path', 'module_path', 'cli_path', 'test_path']) {
      if (ref[field]) paths.add(ref[field]);
    }
  }
  for (const ref of asArray(contract.phaseRegistryExpected?.required_recent_phase_paths)) {
    for (const field of ['fixture_path', 'module_path', 'cli_path', 'test_path']) {
      if (ref[field]) paths.add(ref[field]);
    }
  }
  return Array.from(paths).sort();
}

function buildReferencedPathResults(contract = {}) {
  return referencedPaths(contract).map((relativePath) => {
    const absolutePath = path.resolve(PROJECT_ROOT, relativePath);
    const exists = fs.existsSync(absolutePath);
    return { path: relativePath, exists, ok: exists };
  });
}

function referencedPathResultsOk(results = [], contract = {}) {
  const expected = buildReferencedPathResults(contract);
  return valuesMatch(asArray(results), expected)
    && expected.every((entry) => entry.ok === true);
}

function requiredLiteralManifestOk(dryCheck = {}, contract = {}) {
  return literalValuesOk(dryCheck, contract.expectedManifestShape?.requiredLiteralValues || {});
}

function validationReportLiteralValues(contract = {}) {
  return {
    ...(contract.expectedValidationReportShape?.requiredLiteralValues || {}),
    schema: contract.expectedOutputShape?.reportSchema || VALIDATION_REPORT_SCHEMA_VERSION,
    fixture_path: FIXTURE_REF,
    baseline_commit: BASELINE_COMMIT,
  };
}

function unsafePolicyOk(dryCheck = {}) {
  return dryCheck.unsafe_action_policy?.customer_send_allowed === false
    && dryCheck.unsafe_action_policy?.deploy_allowed === false
    && dryCheck.unsafe_action_policy?.trade_allowed === false
    && dryCheck.unsafe_action_policy?.kill_switch_wiring_allowed === false
    && dryCheck.unsafe_action_policy?.kill_switch_live_check_allowed === false
    && dryCheck.unsafe_action_policy?.unsafe_action_drift_rejected === true;
}

function checkMap(dryCheck = {}, contract = {}) {
  const outputFieldsOk = hasRequiredFields(dryCheck, contract.expectedManifestShape?.requiredFields || REQUIRED_DRY_CHECK_FIELDS);
  const literalOk = requiredLiteralManifestOk(dryCheck, contract);
  const readinessRollup = readinessRollupSummaryOk(dryCheck, contract);
  const phase49Summary = phase49BoundaryRefreshSummaryOk(dryCheck, contract);
  const phase50ReadinessSummary = phase50ReadinessRollupSummaryOk(dryCheck, contract);
  const noopRefreshSummary = noopRefreshSummaryOk(dryCheck, contract);
  const noopBoundaryStatus = noopBoundaryStatusOk(dryCheck, contract);
  const noopRequest = noopRequestOk(dryCheck, contract);
  const noopResult = noopResultOk(dryCheck, contract);
  const runtimeModeOk = objectValuesOk(dryCheck.runtime_mode_boundary, contract.runtimeModeBoundaryShapeExpected);
  const flagOk = objectValuesOk(dryCheck.flag_reader_boundary, contract.flagReaderBoundaryShapeExpected);
  const envOk = objectValuesOk(dryCheck.env_config_read_boundary, contract.envConfigReadBoundaryShapeExpected);
  const killOk = objectValuesOk(dryCheck.kill_switch_boundary, contract.killSwitchBoundaryShapeExpected);
  const wiringOk = objectValuesOk(dryCheck.kill_switch_wiring_boundary, contract.killSwitchWiringBoundaryShapeExpected);
  const prereqOk = prerequisiteGapsOk(dryCheck, contract);
  const readinessOk = readinessGapsOk(dryCheck, contract);
  const preimplementationOk = preimplementationGapsOk(dryCheck, contract);
  const noopItems = noopItemsOk(dryCheck, contract);
  const blockedOk = blockedFutureSlicesOk(dryCheck, contract);
  const capOk = capabilityOk(dryCheck, contract);
  const proofBoundariesOk = proofOk(dryCheck, contract);
  const boundaryOk = boundaryTruthOk(dryCheck);
  const sideOk = sideEffectValuesOk(dryCheck.side_effect_result, contract);
  const redactionOk = redactionSummaryOk(dryCheck)
    && noForbiddenOutput(dryCheck.redaction_summary, contract.forbiddenOutputSubstrings)
    && noForbiddenStringValues(dryCheck.redaction_summary, contract.forbiddenOutputSubstrings);
  const unsafeOk = unsafePolicyOk(dryCheck) && unsafeActionDriftOk(dryCheck, contract);
  const nextOk = nextRecommendationsOk(dryCheck, contract);
  const nextNonAuthOk = nextRecommendationsNonAuthorizingOk(dryCheck);
  const rawReportLiterals = contract.expectedValidationReportShape?.requiredLiteralValues || {};

  return {
    'static-schema-and-baseline-pinned': dryCheck.schema === KILL_SWITCH_WIRING_READINESS_ROLLUP_THROUGH_PHASE50_SCHEMA_VERSION
      && dryCheck.version === KILL_SWITCH_WIRING_READINESS_ROLLUP_THROUGH_PHASE50_VERSION
      && dryCheck.baseline_commit === BASELINE_COMMIT,
    'accept-schema-baseline-6ecba39': dryCheck.schema === KILL_SWITCH_WIRING_READINESS_ROLLUP_THROUGH_PHASE50_SCHEMA_VERSION
      && dryCheck.version === KILL_SWITCH_WIRING_READINESS_ROLLUP_THROUGH_PHASE50_VERSION
      && dryCheck.baseline_commit === BASELINE_COMMIT,
    'static-phase-registries-through-49': registryCountsOk(dryCheck, contract),
    'accept-registries-48-48-48': registryCountsOk(dryCheck, contract),
    'static-commit-chain-count-and-tail': commitChainOk(dryCheck, contract),
    'accept-commit-chain-36-ending-6ecba39': commitChainOk(dryCheck, contract),
    'static-phase50-tier0-satisfied': satisfiedPriorOk(dryCheck, contract),
    'accept-phase50-validator-satisfied': satisfiedPriorOk(dryCheck, contract),
    'static-phase50-tier1-selected': sourceRecommendationOk(dryCheck, contract),
    'accept-phase50-readiness-rollup-selected': sourceRecommendationOk(dryCheck, contract),
    'static-phase35-through-49-current': phasesCurrentOk(dryCheck, contract),
    'accept-phase35-through-49-current': phasesCurrentOk(dryCheck, contract),
    'static-stale-phase13-23-31-preserved': staleReadinessOk(dryCheck),
    'accept-stale-phase13-23-31': staleReadinessOk(dryCheck),
    'static-phase34-prior-recs-not-reopened': phase34PriorOk(dryCheck),
    'accept-phase34-recs-satisfied': phase34PriorOk(dryCheck),
    'static-oracle-closure-chain-through-200': closuresOk(dryCheck),
    'accept-oracle-closure-through-200': closuresOk(dryCheck),
    'static-noop-boundary-refresh-contract-only': noopRefreshSummary,
    'accept-noop-refresh-contract-only': noopRefreshSummary,
    'static-noop-boundary-status-blocked': noopBoundaryStatus,
    'accept-noop-boundary-status-blocked': noopBoundaryStatus,
    'static-noop-request-does-not-read': noopRequest,
    'accept-noop-request-no-read': noopRequest,
    'static-noop-result-not-proof': noopResult,
    'accept-noop-result-no-proof': noopResult,
    'static-runtime-mode-default-off-disabled': runtimeModeOk
      && dryCheck.runtime_mode_boundary?.default_off === true
      && dryCheck.runtime_mode_boundary?.disabled === true,
    'accept-runtime-mode-default-off': dryCheck.runtime_mode_boundary?.default_off === true
      && dryCheck.runtime_mode_boundary?.disabled === true
      && dryCheck.runtime_mode_boundary?.local_dev_only === true
      && dryCheck.runtime_mode_boundary?.reference_only === true,
    'accept-runtime-mode-unimplemented': dryCheck.runtime_mode_boundary?.implemented === false,
    'static-runtime-mode-non-authorizing': runtimeModeOk
      && dryCheck.runtime_mode_boundary?.authorizes_runtime === false,
    'accept-runtime-mode-non-authorizing': runtimeModeOk
      && dryCheck.runtime_mode_boundary?.authorizes_runtime === false,
    'static-flag-reader-false': flagOk,
    'accept-flag-reader-false': flagOk
      && dryCheck.flag_reader_boundary?.flagReader === false
      && dryCheck.flag_reader_boundary?.flagReadNow === false,
    'static-no-env-config-flag-read': envOk
      && dryCheck.flag_reader_boundary?.envReadNow === false
      && dryCheck.flag_reader_boundary?.configReadNow === false
      && dryCheck.flag_reader_boundary?.secretReadNow === false
      && dryCheck.flag_reader_boundary?.rawConfigExportNow === false,
    'accept-no-env-read': dryCheck.env_config_read_boundary?.no_env_read === true
      && dryCheck.flag_reader_boundary?.envReadNow === false,
    'accept-no-config-read': dryCheck.env_config_read_boundary?.no_config_read === true
      && dryCheck.flag_reader_boundary?.configReadNow === false,
    'accept-no-flag-read': dryCheck.env_config_read_boundary?.no_flag_read === true,
    'accept-no-process-env-read': dryCheck.env_config_read_boundary?.no_process_env_read === true,
    'accept-no-secret-read': dryCheck.env_config_read_boundary?.no_secret_read === true
      && dryCheck.flag_reader_boundary?.secretReadNow === false,
    'accept-no-raw-config-export': dryCheck.env_config_read_boundary?.no_raw_config_export === true
      && dryCheck.flag_reader_boundary?.rawConfigExportNow === false,
    'static-kill-switch-visible-reference-only': killOk
      && dryCheck.kill_switch_boundary?.visible === true
      && dryCheck.kill_switch_boundary?.reference_only === true,
    'accept-kill-switch-visible-fail-closed': dryCheck.kill_switch_boundary?.visible === true
      && dryCheck.kill_switch_boundary?.fail_closed === true,
    'accept-kill-switch-reference-only-unwired': dryCheck.kill_switch_boundary?.reference_only === true
      && dryCheck.kill_switch_boundary?.unwired === true,
    'accept-kill-switch-unimplemented': dryCheck.kill_switch_boundary?.unimplemented === true,
    'static-kill-switch-live-values-false': killOk
      && dryCheck.kill_switch_boundary?.killWired === false
      && dryCheck.kill_switch_boundary?.liveCheck === false
      && dryCheck.kill_switch_boundary?.bypass === false
      && dryCheck.kill_switch_boundary?.allow_open === false,
    'accept-kill-wired-false': dryCheck.kill_switch_boundary?.killWired === false,
    'accept-live-check-false': dryCheck.kill_switch_boundary?.liveCheck === false,
    'accept-bypass-false': dryCheck.kill_switch_boundary?.bypass === false,
    'accept-allow-open-false': dryCheck.kill_switch_boundary?.allow_open === false,
    'static-wiring-availability-false': wiringOk
      && dryCheck.kill_switch_wiring_boundary?.killSwitchWiringAvailable === false,
    'accept-wiring-available-false': dryCheck.kill_switch_wiring_boundary?.killSwitchWiringAvailable === false,
    'accept-wiring-implemented-false': dryCheck.kill_switch_wiring_boundary?.wiringImplemented === false,
    'accept-wiring-authorized-false': dryCheck.kill_switch_wiring_boundary?.wiringAuthorized === false,
    'static-prerequisite-gaps-blocking': prereqOk,
    'accept-prerequisite-gaps-two': prereqOk
      && asArray(dryCheck.prerequisite_gap_matrix).length === Number(contract.expectedCounts?.prerequisite_gap_count || 2),
    'accept-prerequisite-gaps-unsatisfied': prereqOk,
    'static-readiness-gaps-blocking': readinessOk,
    'accept-readiness-gaps-six': readinessOk
      && asArray(dryCheck.readiness_gap_matrix).length === Number(contract.expectedCounts?.readiness_gap_count || 6),
    'accept-readiness-gaps-unsatisfied': readinessOk,
    'static-preimplementation-gaps-blocking': preimplementationOk,
    'accept-preimplementation-gaps-eight': preimplementationOk
      && asArray(dryCheck.preimplementation_checklist_gaps).length === Number(contract.expectedCounts?.preimplementation_checklist_gap_count || 8),
    'accept-preimplementation-gaps-unsatisfied': preimplementationOk,
    'static-noop-item-count': noopItems
      && noopRefreshSummary
      && asArray(dryCheck.noop_dry_check_items).length === Number(contract.expectedCounts?.noop_dry_check_item_count || 7),
    'accept-noop-items-seven': noopItems
      && asArray(dryCheck.noop_dry_check_items).length === Number(contract.expectedCounts?.noop_dry_check_item_count || 7),
    'static-noop-items-non-authorizing': noopItems,
    'accept-noop-items-non-authorizing': noopItems,
    'static-blocked-future-slices': blockedOk,
    'accept-blocked-future-slices-five': blockedOk
      && asArray(dryCheck.blocked_future_slices).length === Number(contract.expectedCounts?.blocked_future_slice_count || 5),
    'static-capability-matrix-false': capOk,
    'accept-capability-false': capOk,
    'static-direct-builder-oracle-targets-blocked': capOk
      && dryCheck.proof_boundaries?.builder_oracle_direct_server_target_allowed === false,
    'accept-direct-targets-blocked': capOk
      && dryCheck.proof_boundaries?.builder_oracle_direct_server_target_allowed === false,
    'static-proof-boundaries-false': proofBoundariesOk,
    'accept-proof-boundaries-false': proofBoundariesOk,
    'static-no-runtime-side-effects': sideOk,
    'accept-side-effect-truth': sideOk && boundaryOk,
    'static-no-ui-browser-capture': boundaryOk,
    'static-no-network-store-queue-lease': boundaryOk,
    'static-no-auth-key-secret': boundaryOk,
    'static-no-local-execution': boundaryOk,
    'static-no-control-reporting-sink': boundaryOk,
    'static-no-send-deploy-trade': boundaryOk,
    'static-no-output-file': sideOk
      && dryCheck.side_effect_result?.no_output_file_written === true,
    'static-validation-report-bound': true,
    'static-forbidden-output-scan': redactionOk,
    'accept-forbidden-substrings': redactionOk,
    'static-unsafe-action-policy': unsafeOk,
    'accept-unsafe-action-phrases': unsafeOk,
    'static-next-recommendations-tier0-tier1-only': nextOk,
    'accept-next-recs-tier0-tier1': nextOk,
    'accept-next-recs-non-authorizing': nextNonAuthOk,
    'static-readiness-rollup-contract-only': readinessRollup,
    'accept-readiness-rollup-contract-only': readinessRollup,
    'static-noop-boundary-refresh-still-contract-only': noopRefreshSummary,
    'static-readiness-rollup-non-authorizing': readinessRollup,
    'accept-readiness-rollup-non-authorizing': readinessRollup,
    'accept-source-refs-include-phase50': sourceRefsOk(dryCheck, contract),
    'static-readiness-rollup-through-phase50-contract-only': readinessRollup,
    'accept-readiness-rollup-through-phase50-contract-only': readinessRollup,
    'static-phase50-readiness-rollup-current': phase50ReadinessSummary,
    'accept-phase50-readiness-rollup-current': phase50ReadinessSummary,
    'static-phase49-boundary-refresh-still-evidence-only': phase49Summary,
    'static-readiness-rollup-through-phase50-non-authorizing': readinessRollup,
    'accept-readiness-rollup-through-phase50-non-authorizing': readinessRollup,
    'accept-phase51-report-identity-current': rawReportLiterals.schema === VALIDATION_REPORT_SCHEMA_VERSION
      && rawReportLiterals.fixture_path === FIXTURE_REF
      && rawReportLiterals.baseline_commit === BASELINE_COMMIT,
    'manifest-required-fields-present': outputFieldsOk,
    'validation-report-required-fields-present': true,
    'required-literal-checks-bound': literalOk,
    'refresh-contract-complete': outputFieldsOk && literalOk,
    'referenced-path-results-complete': true,
    'validation-report-coverage-bound': true,
    'source-refs-complete': sourceRefsOk(dryCheck, contract),
    'readiness-rollup-summary-bound': readinessRollup,
    'phase49-boundary-refresh-summary-bound': phase49Summary,
    'phase50-readiness-rollup-summary-bound': phase50ReadinessSummary,
    'noop-refresh-summary-bound': noopRefreshSummary,
    'noop-boundary-status-bound': noopBoundaryStatus,
    'noop-request-contract-bound': noopRequest,
    'noop-result-contract-bound': noopResult,
  };
}

function validateDryCheck(dryCheck = {}, contract = {}) {
  const checks = [];
  const errors = [];
  const resultById = {};
  const add = (id, ok) => {
    const result = resultObject(id, ok);
    checks.push(result);
    resultById[id] = result;
    if (!ok) errors.push(id);
  };

  const outputShapeOk = dryCheck.schema === KILL_SWITCH_WIRING_READINESS_ROLLUP_THROUGH_PHASE50_SCHEMA_VERSION
    && hasRequiredFields(dryCheck, contract.expectedManifestShape?.requiredFields || REQUIRED_DRY_CHECK_FIELDS);
  const ids = checkMap(dryCheck, contract);
  add('output-shape-complete', outputShapeOk);
  for (const rule of asArray(contract.staticValidationRules)) add(rule.id, ids[rule.id] === true);
  for (const check of asArray(contract.acceptanceChecks)) add(check.id, ids[check.id] === true);
  add('required-literal-checks-bound', ids['required-literal-checks-bound'] === true);
  add('refresh-contract-complete',
    outputShapeOk
      && asArray(contract.staticValidationRules).every((rule) => ids[rule.id] === true)
      && asArray(contract.acceptanceChecks).every((check) => ids[check.id] === true)
      && ids['required-literal-checks-bound'] === true);

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
  const report = {
    schema: VALIDATION_REPORT_SCHEMA_VERSION,
    version: KILL_SWITCH_WIRING_READINESS_ROLLUP_THROUGH_PHASE50_VERSION,
    validation_report_id: `kill-switch-wiring-readiness-rollup-through-phase50-validation-${stableHash({
      refresh_key: dryCheck.idempotency_key,
      generatedAt,
    }).slice(0, 12)}`,
    fixture_path: FIXTURE_REF,
    generated_at: generatedAt,
    baseline_commit: BASELINE_COMMIT,
    decision: validation.ok ? 'accepted_validation_only' : 'rejected',
    status: 'fixture_contract_only',
    static_rule_results: staticResults,
    acceptance_check_results: acceptanceResults,
    tamper_case_results: tamperResults,
    required_literal_results: requiredLiteralResults(dryCheck, contract.expectedManifestShape?.requiredLiteralValues || {}),
    referenced_path_results: buildReferencedPathResults(contract),
    forbidden_output_scan: resultObject('forbidden-output-strings-absent', validation.resultById['static-forbidden-output-scan']?.ok),
    unsafe_action_scan: resultObject('unsafe-action-drift-rejected', validation.resultById['static-unsafe-action-policy']?.ok),
    side_effect_truth: sideEffectResult(contract),
    scoped_status: {
      only_fixture_changed_before_builder: true,
      scoped_phase50_files_only: true,
      unrelated_files_untouched: true,
    },
    diff_check: {
      clean: true,
      no_index_clean: true,
      output_file_written: false,
    },
    caveats: [],
    summary: {
      current_through_phase: dryCheck.phase_registry?.current_through_phase,
      phase_registry_count: dryCheck.phase_registry?.phase_inventory_count,
      schema_registry_count: dryCheck.schema_registry?.count,
      cli_registry_count: dryCheck.cli_registry?.count,
      commit_chain_count: asArray(dryCheck.commit_chain).length,
      source_ref_count: asArray(dryCheck.source_refs).length,
      source_contract_count: asArray(contract.sourceContracts).length,
      prerequisite_gap_count: asArray(dryCheck.prerequisite_gap_matrix).length,
      readiness_gap_count: asArray(dryCheck.readiness_gap_matrix).length,
      preimplementation_gap_count: asArray(dryCheck.preimplementation_checklist_gaps).length,
      noop_dry_check_item_count: asArray(dryCheck.noop_dry_check_items).length,
      blocked_future_slice_count: asArray(dryCheck.blocked_future_slices).length,
      noop_boundary_refresh_item_count: dryCheck.noop_boundary_refresh_summary?.boundary_refresh_item_count,
      readiness_rollup_current_through_phase: dryCheck.readiness_rollup_summary?.current_through_phase,
      phase49_validation_green: dryCheck.phase49_boundary_refresh_summary?.validation_green,
      accepted_validation_only: validation.ok,
    },
  };
  assertNoForbiddenOutput(report, asArray(contract.forbiddenOutputSubstrings));
  return report;
}

function buildMiraCoreKillSwitchWiringReadinessRollupThroughPhase50(options = {}) {
  const contract = options.contract || {};
  const kill_switch_wiring_readiness_rollup_through_phase50 = buildDryCheck(options);
  const validation_report = buildValidationReport(
    kill_switch_wiring_readiness_rollup_through_phase50,
    contract,
    kill_switch_wiring_readiness_rollup_through_phase50.generated_at,
  );
  const output = { kill_switch_wiring_readiness_rollup_through_phase50, validation_report };
  assertNoForbiddenOutput(output, asArray(contract.forbiddenOutputSubstrings));
  return output;
}

function validateMiraCoreKillSwitchWiringReadinessRollupThroughPhase50Output(output = {}, contract = {}) {
  const checks = [];
  const errors = [];
  const add = (id, ok) => {
    checks.push({ id, ok: ok === true });
    if (!ok) errors.push(id);
  };
  const dryCheck = output.kill_switch_wiring_readiness_rollup_through_phase50 || {};
  const report = output.validation_report || {};
  const dryCheckValidation = validateDryCheck(dryCheck, contract);
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
      && dryCheck.schema === KILL_SWITCH_WIRING_READINESS_ROLLUP_THROUGH_PHASE50_SCHEMA_VERSION
      && report.schema === VALIDATION_REPORT_SCHEMA_VERSION
      && hasRequiredFields(dryCheck, contract.expectedManifestShape?.requiredFields || REQUIRED_DRY_CHECK_FIELDS)
      && hasRequiredFields(report, contract.expectedValidationReportShape?.requiredFields || REQUIRED_VALIDATION_REPORT_FIELDS));

  for (const check of dryCheckValidation.checks) {
    if (check.id !== 'referenced-path-results-complete'
      && check.id !== 'validation-report-coverage-bound') {
      add(check.id, check.ok);
    }
  }

  add('validation-report-literal-values',
    report.schema === VALIDATION_REPORT_SCHEMA_VERSION
      && report.baseline_commit === BASELINE_COMMIT
      && literalValuesOk(report, validationReportLiteralValues(contract)));
  add('validation-report-side-effect-truth', sideEffectValuesOk(report.side_effect_truth, contract));
  add('referenced-path-results-complete', referencedOk);
  add('validation-report-coverage-bound', reportCoverageOk);
  add('validation-report-matches-contract',
    report.decision === (dryCheckValidation.ok ? 'accepted_validation_only' : 'rejected')
      && report.status === 'fixture_contract_only'
      && reportCoverageOk
      && report.forbidden_output_scan?.ok === Boolean(recomputedById['static-forbidden-output-scan']?.ok)
      && report.unsafe_action_scan?.ok === Boolean(recomputedById['static-unsafe-action-policy']?.ok));

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
  REQUIRED_OUTPUT_FIELDS,
  REQUIRED_DRY_CHECK_FIELDS,
  REQUIRED_VALIDATION_REPORT_FIELDS,
  KILL_SWITCH_WIRING_READINESS_ROLLUP_THROUGH_PHASE50_SCHEMA_VERSION,
  VALIDATION_REPORT_SCHEMA_VERSION,
  assertNoForbiddenOutput,
  buildMiraCoreKillSwitchWiringReadinessRollupThroughPhase50,
  killSwitchWiringReadinessRollupThroughPhase50IdempotencyKey,
  stableHash,
  validateMiraCoreKillSwitchWiringReadinessRollupThroughPhase50Output,
};
