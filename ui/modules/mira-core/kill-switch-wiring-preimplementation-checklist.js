'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const KILL_SWITCH_WIRING_PREIMPLEMENTATION_CHECKLIST_SCHEMA_VERSION =
  'squidrun.mira_core.kill_switch_wiring_preimplementation_checklist.v0';
const VALIDATION_REPORT_SCHEMA_VERSION =
  'squidrun.mira_core.kill_switch_wiring_preimplementation_checklist_validation_report.v0';
const KILL_SWITCH_WIRING_PREIMPLEMENTATION_CHECKLIST_VERSION = 0;
const BASELINE_COMMIT = 'bbf6e9f';
const FIXTURE_REF =
  'ui/__tests__/fixtures/mira-core-kill-switch-wiring-preimplementation-checklist-contract.json';

const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');

const REQUIRED_OUTPUT_FIELDS = Object.freeze([
  'kill_switch_wiring_preimplementation_checklist',
  'validation_report',
]);

const REQUIRED_CHECKLIST_FIELDS = Object.freeze([
  'schema',
  'version',
  'checklist_id',
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
  'preimplementation_checklist_summary',
  'runtime_mode_boundary',
  'flag_reader_boundary',
  'env_config_read_boundary',
  'kill_switch_boundary',
  'kill_switch_wiring_boundary',
  'prerequisite_gap_matrix',
  'readiness_gap_matrix',
  'checklist_items',
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
  'kill switch bypass allowed',
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
  const pathParts = String(dottedPath || '')
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .filter(Boolean);
  return pathParts.reduce((acc, key) => (
    acc && Object.prototype.hasOwnProperty.call(acc, key) ? acc[key] : undefined
  ), value);
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

function evidenceRef(store, eventId, relation = 'kill_switch_wiring_preimplementation_checklist_validation') {
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
    sessionId: inputSignals.sessionId || 'session-346',
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
    expected_phases: expected.expected_phases || '1-46',
    current_through_phase: expected.phase_inventory_count || 46,
    phase_inventory_count: expected.phase_inventory_count || 46,
    phase35_current: true,
    phase36_current: true,
    phase37_current: true,
    phase38_current: true,
    phase39_current: true,
    phase40_current: true,
    phase41_current: true,
    phase42_current: true,
    phase43_current: true,
    phase44_current: true,
    phase45_current: true,
    phase46_current: true,
    phase46_commit: BASELINE_COMMIT,
    phase46_delta: clone(expected.phase46_delta || {}),
    phase34_prior_recommendations: expected.phase34_prior_recommendations,
    recent_phase_paths: clone(expected.required_recent_phase_paths || []),
    evidenceRefs: [
      evidenceRef('git', BASELINE_COMMIT, 'phase47-baseline'),
      evidenceRef('mira-core-kill-switch-wiring-preimplementation-checklist-contract', 'phase-registry'),
    ],
  };
}

function registry(kind, contract = {}) {
  const count = Number(contract.expectedCounts?.[`${kind}_registry_count`] || 46);
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

function prerequisiteGapMatrix(contract = {}) {
  return asArray(contract.prerequisiteGapMatrixExpected).map((gap) => ({
    ...clone(gap),
    evidenceRefs: [evidenceRef('mira-core-kill-switch-wiring-preimplementation-checklist-contract', gap.gap_id)],
  }));
}

function readinessGapMatrix(contract = {}) {
  return asArray(contract.readinessGapMatrixExpected).map((gap) => ({
    ...clone(gap),
    evidenceRefs: [evidenceRef('mira-core-kill-switch-wiring-preimplementation-checklist-contract', gap.gap_id)],
  }));
}

function checklistItems(contract = {}) {
  return asArray(contract.checklistItemsExpected).map((item) => ({
    ...clone(item),
    contract_only: true,
    evidenceRefs: [evidenceRef('mira-core-kill-switch-wiring-preimplementation-checklist-contract', item.check_id)],
  }));
}

function blockedFutureSlices(contract = {}) {
  return asArray(contract.blockedFutureSlicesExpected).map((slice) => ({
    ...clone(slice),
    reason: `Slice ${slice.slice_id} remains blocked by the Phase 47 preimplementation checklist boundary.`,
    evidenceRefs: [evidenceRef('mira-core-kill-switch-wiring-preimplementation-checklist-contract', slice.slice_id)],
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
    evidenceRefs: [evidenceRef('mira-core-kill-switch-wiring-preimplementation-checklist-contract', 'redaction-summary')],
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
    evidenceRefs: [evidenceRef('mira-core-kill-switch-wiring-preimplementation-checklist-contract', 'unsafe-action-policy')],
  };
}

function sideEffectResult(contract = {}) {
  const expected = contract.sideEffectTruthExpected || {};
  const result = Object.keys(expected).reduce((acc, field) => {
    acc[field] = true;
    return acc;
  }, {});
  for (const field of EXTRA_FALSE_SIDE_EFFECT_FIELDS) result[field] = false;
  for (const field of SIDE_EFFECT_COUNTER_FIELDS) result[field] = 0;
  return result;
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
      'env-config-read',
      'kill-switch-wire',
      'kill-switch-live-check',
      'kill-switch-bypass',
      'kill-switch-allow-open',
      'irreversible-action-boundary',
    ],
    evidenceRefs: [
      evidenceRef('mira-core-kill-switch-wiring-preimplementation-checklist-contract', `next:${candidate.recommendation_id}`),
    ],
  }));
}

function canonicalChecklistInput(checklist = {}) {
  return {
    profile: checklist.profile,
    sessionId: checklist.sessionId,
    deviceId: checklist.deviceId,
    baseline_commit: checklist.baseline_commit,
    phase_registry: checklist.phase_registry,
    schema_registry: checklist.schema_registry,
    cli_registry: checklist.cli_registry,
    commit_chain: checklist.commit_chain,
    source_recommendation: checklist.source_recommendation,
    satisfied_prior_recommendations: checklist.satisfied_prior_recommendations,
    current_truth: checklist.current_truth,
    stale_readiness: checklist.stale_readiness,
    phase34_prior_recommendations: checklist.phase34_prior_recommendations,
    closure_summary: checklist.closure_summary,
    source_refs: checklist.source_refs,
    preimplementation_checklist_summary: checklist.preimplementation_checklist_summary,
    runtime_mode_boundary: checklist.runtime_mode_boundary,
    flag_reader_boundary: checklist.flag_reader_boundary,
    env_config_read_boundary: checklist.env_config_read_boundary,
    kill_switch_boundary: checklist.kill_switch_boundary,
    kill_switch_wiring_boundary: checklist.kill_switch_wiring_boundary,
    prerequisite_gap_matrix: checklist.prerequisite_gap_matrix,
    readiness_gap_matrix: checklist.readiness_gap_matrix,
    checklist_items: checklist.checklist_items,
    blocked_future_slices: checklist.blocked_future_slices,
    capability_matrix: checklist.capability_matrix,
    proof_boundaries: checklist.proof_boundaries,
    boundary_truth: checklist.boundary_truth,
    redaction_summary: checklist.redaction_summary,
    unsafe_action_policy: checklist.unsafe_action_policy,
    next_phase_recommendations: checklist.next_phase_recommendations,
    side_effect_result: checklist.side_effect_result,
  };
}

function killSwitchWiringPreimplementationChecklistIdempotencyKey(checklist) {
  return `kill-switch-wiring-preimplementation-checklist:${stableHash(canonicalChecklistInput(checklist))}`;
}

function buildChecklist(options = {}) {
  const contract = options.contract || {};
  const inputSignals = options.inputSignals || {};
  const scope = normalizeScope(inputSignals);
  const generatedAt = generatedAtFromOptions(options, inputSignals);
  const checklist = {
    schema: KILL_SWITCH_WIRING_PREIMPLEMENTATION_CHECKLIST_SCHEMA_VERSION,
    version: KILL_SWITCH_WIRING_PREIMPLEMENTATION_CHECKLIST_VERSION,
    checklist_id: `kill-switch-wiring-preimplementation-checklist-${stableHash({
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
    stale_readiness: withEvidence(contract.phaseRegistryExpected?.stale_truth || {}, 'mira-core-runtime-status-milestone-refresh', 'stale-readiness'),
    phase34_prior_recommendations: withEvidence(
      { satisfied_and_not_reopened: true },
      'git',
      'c04155d',
    ),
    closure_summary: withEvidence(closureSummaryValues(contract), 'oracle-review', 'closure-summary'),
    source_refs: clone(contract.sourceRefsExpected || []),
    preimplementation_checklist_summary: withEvidence(
      contract.preimplementationChecklistSummaryExpected || {},
      'mira-core-kill-switch-wiring-preimplementation-checklist-contract',
      'checklist-summary',
    ),
    runtime_mode_boundary: withEvidence(
      contract.runtimeModeBoundaryShapeExpected?.requiredValues || {},
      'mira-core-runtime-mode-kill-switch-implementation-risk-contract',
      'runtime-mode-boundary',
    ),
    flag_reader_boundary: withEvidence(
      contract.flagReaderBoundaryShapeExpected?.requiredValues || {},
      'mira-core-runtime-mode-flag-reader-safety-contract',
      'flag-reader-boundary',
    ),
    env_config_read_boundary: withEvidence(
      contract.envConfigReadBoundaryShapeExpected?.requiredValues || {},
      'mira-core-runtime-mode-flag-reader-safety-contract',
      'env-config-read-boundary',
    ),
    kill_switch_boundary: withEvidence(
      contract.killSwitchBoundaryShapeExpected?.requiredValues || {},
      'mira-core-kill-switch-wiring-safety-contract',
      'kill-switch-boundary',
    ),
    kill_switch_wiring_boundary: withEvidence(
      contract.killSwitchWiringBoundaryShapeExpected?.requiredValues || {},
      'mira-core-kill-switch-wiring-readiness-gap-contract',
      'kill-switch-wiring-boundary',
    ),
    prerequisite_gap_matrix: prerequisiteGapMatrix(contract),
    readiness_gap_matrix: readinessGapMatrix(contract),
    checklist_items: checklistItems(contract),
    blocked_future_slices: blockedFutureSlices(contract),
    capability_matrix: withEvidence(contract.capabilityMatrixExpected || {}, 'mira-core-kill-switch-wiring-preimplementation-checklist-contract', 'capability-matrix'),
    proof_boundaries: withEvidence(contract.proofBoundaryExpected || {}, 'mira-core-kill-switch-wiring-preimplementation-checklist-contract', 'proof-boundaries'),
    boundary_truth: withEvidence(boundaryTruthValues(), 'mira-core-kill-switch-wiring-preimplementation-checklist-contract', 'boundary-truth'),
    redaction_summary: redactionSummary(),
    unsafe_action_policy: unsafeActionPolicy(),
    next_phase_recommendations: nextPhaseRecommendations(contract),
    evidenceRefs: [
      evidenceRef('git', BASELINE_COMMIT, 'phase47-baseline'),
      evidenceRef('fixture', FIXTURE_REF, 'oracle-contract'),
    ],
    side_effect_result: sideEffectResult(contract),
  };
  checklist.idempotency_key = killSwitchWiringPreimplementationChecklistIdempotencyKey(checklist);
  return checklist;
}

function closureSummaryValues(contract = {}) {
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
    closed_review_refs: [
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
    ],
    source_contracts_count: asArray(contract.sourceContracts).length,
  };
}

function currentTruthValues(contract = {}) {
  return {
    ...clone(contract.phaseRegistryExpected?.current_truth || {}),
    kill_switch_wiring_preimplementation_checklist_remains_non_authorizing: true,
    no_env_config_flag_read_now: true,
    kill_switch_remains_unwired: true,
  };
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

function registryCountsOk(checklist = {}) {
  return checklist.phase_registry?.phase_inventory_count === 46
    && checklist.schema_registry?.count === 46
    && checklist.cli_registry?.count === 46
    && asArray(checklist.schema_registry?.entries).length === 46
    && asArray(checklist.cli_registry?.entries).length === 46;
}

function commitChainOk(checklist = {}, contract = {}) {
  const expected = contract.commitChainExpected || [];
  return valuesMatch(checklist.commit_chain, expected)
    && asArray(checklist.commit_chain).length === 34
    && checklist.commit_chain?.[checklist.commit_chain.length - 1] === BASELINE_COMMIT;
}

function phasesCurrentOk(checklist = {}) {
  return [35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46].every((phase) => (
    checklist.phase_registry?.[`phase${phase}_current`] === true
    && checklist.current_truth?.[`phase${phase}_current`] === true
  ));
}

function sourceRecommendationOk(checklist = {}, contract = {}) {
  const source = checklist.source_recommendation || {};
  return containsExpectedValues(source, contract.sourceRecommendation || {})
    && source.recommendation_id === 'phase47-kill-switch-wiring-preimplementation-checklist-contract'
    && source.tier === 'tier1'
    && source.selected_as === 'fixture_only_contract'
    && source.implementation_status === 'not_implemented'
    && source.does_not_authorize_kill_switch_wiring === true;
}

function satisfiedPriorOk(checklist = {}, contract = {}) {
  const expected = asArray(contract.satisfiedPriorRecommendations);
  return asArray(checklist.satisfied_prior_recommendations).length === expected.length
    && asArray(checklist.satisfied_prior_recommendations).every((entry, index) => containsExpectedValues(entry, expected[index]));
}

function staleReadinessOk(checklist = {}) {
  return checklist.stale_readiness?.phase13_stale === true
    && checklist.stale_readiness?.phase23_stale === true
    && checklist.stale_readiness?.phase31_stale === true;
}

function phase34PriorOk(checklist = {}) {
  return checklist.phase34_prior_recommendations?.satisfied_and_not_reopened === true;
}

function closuresOk(checklist = {}) {
  return checklist.closure_summary?.oracle_182_phase46_review_closure_carried === true
    && asArray(checklist.closure_summary?.closed_review_refs).includes('ORACLE #182');
}

function sourceRefsOk(checklist = {}, contract = {}) {
  return valuesMatch(checklist.source_refs, contract.sourceRefsExpected || [])
    && asArray(checklist.source_refs).length === 16
    && asArray(checklist.source_refs).some((ref) => ref.artifact_id === 'phase46-kill-switch-wiring-readiness-gap');
}

function checklistSummaryOk(checklist = {}, contract = {}) {
  const summary = checklist.preimplementation_checklist_summary || {};
  return containsExpectedValues(summary, contract.preimplementationChecklistSummaryExpected || {})
    && summary.checklist_count === asArray(checklist.checklist_items).length
    && summary.ready_for_runtime_now === false
    && summary.ready_for_dry_run_now === false
    && summary.ready_for_kill_switch_wiring_now === false
    && summary.all_items_blocking === true
    && summary.all_items_non_authorizing === true;
}

function matrixValuesOk(actual = [], expected = []) {
  return asArray(actual).length === asArray(expected).length
    && asArray(actual).every((entry, index) => containsExpectedValues(entry, expected[index]));
}

function prerequisiteGapsOk(checklist = {}, contract = {}) {
  return matrixValuesOk(checklist.prerequisite_gap_matrix, contract.prerequisiteGapMatrixExpected)
    && asArray(checklist.prerequisite_gap_matrix).every((entry) => (
      entry.status === 'unsatisfied_blocking_non_authorizing'
      && entry.satisfied_now === false
      && entry.blocking === true
      && entry.authorizes_runtime === false
      && entry.authorizes_kill_switch_wiring === false
    ));
}

function readinessGapsOk(checklist = {}, contract = {}) {
  return matrixValuesOk(checklist.readiness_gap_matrix, contract.readinessGapMatrixExpected)
    && asArray(checklist.readiness_gap_matrix).every((entry) => (
      entry.status === 'unsatisfied_blocking_non_authorizing'
      && entry.satisfied_now === false
      && entry.blocking === true
    ));
}

function checklistItemsOk(checklist = {}, contract = {}) {
  return matrixValuesOk(checklist.checklist_items, contract.checklistItemsExpected)
    && asArray(checklist.checklist_items).every((entry) => (
      entry.status === 'required_unsatisfied_blocking_non_authorizing'
      && entry.satisfied_now === false
      && entry.blocks_kill_switch_wiring_now === true
      && entry.authorizes_runtime === false
      && entry.authorizes_kill_switch_wiring === false
    ));
}

function blockedFutureSlicesOk(checklist = {}, contract = {}) {
  return matrixValuesOk(checklist.blocked_future_slices, contract.blockedFutureSlicesExpected)
    && asArray(checklist.blocked_future_slices).every((entry) => (
      entry.status === 'blocked_now_non_authorizing'
      && entry.implementation_allowed_now === false
      && entry.requires_future_contract === true
    ));
}

function capabilityOk(checklist = {}, contract = {}) {
  return containsExpectedValues(checklist.capability_matrix, contract.capabilityMatrixExpected || {})
    && checklist.capability_matrix?.directBuilderOracleServerTargetsBlocked === true
    && Object.entries(contract.capabilityMatrixExpected || {})
      .every(([key, value]) => key === 'directBuilderOracleServerTargetsBlocked' ? value === true : value === false);
}

function proofOk(checklist = {}, contract = {}) {
  return containsExpectedValues(checklist.proof_boundaries, contract.proofBoundaryExpected || {})
    && Object.values(contract.proofBoundaryExpected || {}).every((value) => value === false);
}

function boundaryTruthOk(checklist = {}) {
  return Object.values(boundaryTruthValues()).every((value) => value === true)
    && containsExpectedValues(checklist.boundary_truth, boundaryTruthValues());
}

function sideEffectValuesOk(sideEffect = {}, contract = {}) {
  return Object.keys(contract.sideEffectTruthExpected || {}).every((field) => sideEffect[field] === true)
    && EXTRA_FALSE_SIDE_EFFECT_FIELDS.every((field) => sideEffect[field] === false)
    && SIDE_EFFECT_COUNTER_FIELDS.every((field) => sideEffect[field] === 0);
}

function redactionSummaryOk(checklist = {}) {
  return checklist.redaction_summary?.raw_private_content_exported === false
    && checklist.redaction_summary?.raw_terminal_exported === false
    && checklist.redaction_summary?.raw_screenshot_ocr_browser_exported === false
    && checklist.redaction_summary?.secret_material_exported === false
    && checklist.redaction_summary?.customer_private_content_exported === false
    && checklist.redaction_summary?.raw_config_exported === false;
}

function nextRecommendationsOk(checklist = {}, contract = {}) {
  const actual = asArray(checklist.next_phase_recommendations);
  const expected = asArray(contract.nextRecommendationExpectedCandidates);
  return actual.length === expected.length
    && actual.every((entry, index) => containsExpectedValues(entry, expected[index]))
    && actual.every((entry) => ['tier0', 'tier1'].includes(entry.tier));
}

function nextRecommendationsNonAuthorizingOk(checklist = {}) {
  return asArray(checklist.next_phase_recommendations).every((entry) => (
    entry.does_not_authorize_runtime === true
    && entry.does_not_authorize_execution === true
    && entry.does_not_authorize_kill_switch_wiring === true
    && entry.does_not_authorize_output_files === true
  ));
}

function normalizeText(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9.]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function occurrenceIsNegated(text, index) {
  const window = text.slice(Math.max(0, index - 50), index);
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

function unsafeActionDriftOk(checklist = {}, contract = {}) {
  const expected = asArray(contract.nextRecommendationExpectedCandidates);
  return asArray(checklist.next_phase_recommendations).every((entry, index) => {
    const expectedEntry = expected[index] || {};
    return ['recommendation_id', 'safe_next_action', 'kind'].every((field) => {
      const actualText = entry[field];
      if (actualText === expectedEntry[field]) return true;
      return !textHasUnsafeActionDrift(actualText, contract);
    });
  });
}

function forbiddenOccurrenceIsNegated(text, index) {
  const before = text.slice(Math.max(0, index - 120), index);
  const after = text.slice(index, index + 120);
  return occurrenceIsNegated(text, index)
    || /\b(no|not|false|blocked|disabled|unwired|unimplemented|reference only|side effect|boundary|path|expected|actual|attempts?|attempted|tamper|expectedfailure)\b/.test(before)
    || /\b(false|blocked|disabled|unwired|unimplemented|reference only|side effect|boundary|expected|actual|attempts?|attempted|expectedfailure)\b/.test(after);
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

function requiredLiteralManifestOk(checklist = {}, contract = {}) {
  return literalValuesOk(checklist, contract.expectedManifestShape?.requiredLiteralValues || {});
}

function unsafePolicyOk(checklist = {}) {
  return checklist.unsafe_action_policy?.customer_send_allowed === false
    && checklist.unsafe_action_policy?.deploy_allowed === false
    && checklist.unsafe_action_policy?.trade_allowed === false
    && checklist.unsafe_action_policy?.kill_switch_wiring_allowed === false
    && checklist.unsafe_action_policy?.unsafe_action_drift_rejected === true;
}

function checkMap(checklist = {}, contract = {}) {
  const outputFieldsOk = hasRequiredFields(checklist, contract.expectedManifestShape?.requiredFields || REQUIRED_CHECKLIST_FIELDS);
  const literalOk = requiredLiteralManifestOk(checklist, contract);
  const summaryOk = checklistSummaryOk(checklist, contract);
  const runtimeModeOk = objectValuesOk(checklist.runtime_mode_boundary, contract.runtimeModeBoundaryShapeExpected);
  const flagOk = objectValuesOk(checklist.flag_reader_boundary, contract.flagReaderBoundaryShapeExpected);
  const envOk = objectValuesOk(checklist.env_config_read_boundary, contract.envConfigReadBoundaryShapeExpected);
  const killOk = objectValuesOk(checklist.kill_switch_boundary, contract.killSwitchBoundaryShapeExpected);
  const wiringOk = objectValuesOk(checklist.kill_switch_wiring_boundary, contract.killSwitchWiringBoundaryShapeExpected);
  const prereqOk = prerequisiteGapsOk(checklist, contract);
  const readinessOk = readinessGapsOk(checklist, contract);
  const checklistOk = checklistItemsOk(checklist, contract);
  const blockedOk = blockedFutureSlicesOk(checklist, contract);
  const capOk = capabilityOk(checklist, contract);
  const proofBoundariesOk = proofOk(checklist, contract);
  const boundaryOk = boundaryTruthOk(checklist);
  const sideOk = sideEffectValuesOk(checklist.side_effect_result, contract);
  const redactionOk = redactionSummaryOk(checklist)
    && noForbiddenOutput(checklist.redaction_summary, contract.forbiddenOutputSubstrings);
  const unsafeOk = unsafePolicyOk(checklist) && unsafeActionDriftOk(checklist, contract);
  const nextOk = nextRecommendationsOk(checklist, contract);
  const nextNonAuthOk = nextRecommendationsNonAuthorizingOk(checklist);

  return {
    'static-schema-and-baseline-pinned': checklist.schema === KILL_SWITCH_WIRING_PREIMPLEMENTATION_CHECKLIST_SCHEMA_VERSION
      && checklist.version === KILL_SWITCH_WIRING_PREIMPLEMENTATION_CHECKLIST_VERSION
      && checklist.baseline_commit === BASELINE_COMMIT,
    'accept-schema-baseline-bbf6e9f': checklist.schema === KILL_SWITCH_WIRING_PREIMPLEMENTATION_CHECKLIST_SCHEMA_VERSION
      && checklist.version === KILL_SWITCH_WIRING_PREIMPLEMENTATION_CHECKLIST_VERSION
      && checklist.baseline_commit === BASELINE_COMMIT,
    'static-phase-registries-through-46': registryCountsOk(checklist),
    'accept-registries-46-46-46': registryCountsOk(checklist),
    'static-commit-chain-count-and-tail': commitChainOk(checklist, contract),
    'accept-commit-chain-34-ending-bbf6e9f': commitChainOk(checklist, contract),
    'static-phase46-tier0-satisfied': satisfiedPriorOk(checklist, contract),
    'accept-phase46-validator-satisfied': satisfiedPriorOk(checklist, contract),
    'static-phase46-tier1-selected': sourceRecommendationOk(checklist, contract),
    'accept-phase47-checklist-selected': sourceRecommendationOk(checklist, contract),
    'static-phase35-through-46-current': phasesCurrentOk(checklist),
    'accept-phase35-through-46-current': phasesCurrentOk(checklist),
    'static-stale-phase13-23-31-preserved': staleReadinessOk(checklist),
    'accept-stale-phase13-23-31': staleReadinessOk(checklist),
    'static-phase34-prior-recs-not-reopened': phase34PriorOk(checklist),
    'accept-phase34-recs-satisfied': phase34PriorOk(checklist),
    'static-oracle-closure-chain-through-182': closuresOk(checklist),
    'accept-oracle-closure-through-182': closuresOk(checklist),
    'static-runtime-mode-default-off-disabled': runtimeModeOk
      && checklist.runtime_mode_boundary?.default_off === true
      && checklist.runtime_mode_boundary?.disabled === true,
    'accept-runtime-mode-default-off': checklist.runtime_mode_boundary?.default_off === true
      && checklist.runtime_mode_boundary?.disabled === true,
    'accept-runtime-mode-unimplemented': checklist.runtime_mode_boundary?.implemented === false,
    'static-runtime-mode-non-authorizing': runtimeModeOk
      && checklist.runtime_mode_boundary?.authorizes_runtime === false,
    'accept-runtime-mode-non-authorizing': runtimeModeOk
      && checklist.runtime_mode_boundary?.authorizes_runtime === false,
    'static-flag-reader-false': flagOk,
    'accept-flag-reader-false': flagOk
      && checklist.flag_reader_boundary?.flagReader === false,
    'static-no-env-config-flag-read': envOk,
    'accept-no-env-read': checklist.env_config_read_boundary?.no_env_read === true,
    'accept-no-config-read': checklist.env_config_read_boundary?.no_config_read === true,
    'accept-no-flag-read': checklist.env_config_read_boundary?.no_flag_read === true,
    'accept-no-process-env-read': checklist.env_config_read_boundary?.no_process_env_read === true,
    'accept-no-secret-read': checklist.env_config_read_boundary?.no_secret_read === true,
    'accept-no-raw-config-export': checklist.env_config_read_boundary?.no_raw_config_export === true,
    'static-kill-switch-visible-reference-only': killOk
      && checklist.kill_switch_boundary?.visible === true
      && checklist.kill_switch_boundary?.reference_only === true,
    'accept-kill-switch-visible-fail-closed': checklist.kill_switch_boundary?.visible === true
      && checklist.kill_switch_boundary?.fail_closed === true,
    'accept-kill-switch-reference-only-unwired': checklist.kill_switch_boundary?.reference_only === true
      && checklist.kill_switch_boundary?.unwired === true,
    'accept-kill-switch-unimplemented': checklist.kill_switch_boundary?.unimplemented === true,
    'static-kill-switch-live-values-false': killOk
      && checklist.kill_switch_boundary?.killWired === false
      && checklist.kill_switch_boundary?.liveCheck === false
      && checklist.kill_switch_boundary?.bypass === false
      && checklist.kill_switch_boundary?.allow_open === false,
    'accept-kill-wired-false': checklist.kill_switch_boundary?.killWired === false,
    'accept-live-check-false': checklist.kill_switch_boundary?.liveCheck === false,
    'accept-bypass-false': checklist.kill_switch_boundary?.bypass === false,
    'accept-allow-open-false': checklist.kill_switch_boundary?.allow_open === false,
    'static-wiring-availability-false': wiringOk
      && checklist.kill_switch_wiring_boundary?.killSwitchWiringAvailable === false,
    'accept-wiring-available-false': checklist.kill_switch_wiring_boundary?.killSwitchWiringAvailable === false,
    'accept-wiring-implemented-false': checklist.kill_switch_wiring_boundary?.wiringImplemented === false,
    'accept-wiring-authorized-false': checklist.kill_switch_wiring_boundary?.wiringAuthorized === false,
    'static-prerequisite-gaps-blocking': prereqOk,
    'accept-prerequisite-gaps-two': prereqOk
      && asArray(checklist.prerequisite_gap_matrix).length === 2,
    'accept-prerequisite-gaps-unsatisfied': prereqOk,
    'static-readiness-gaps-blocking': readinessOk,
    'accept-readiness-gaps-six': readinessOk
      && asArray(checklist.readiness_gap_matrix).length === 6,
    'accept-readiness-gaps-unsatisfied': readinessOk,
    'static-checklist-item-count': checklistOk
      && summaryOk
      && asArray(checklist.checklist_items).length === 8,
    'accept-checklist-eight': checklistOk
      && asArray(checklist.checklist_items).length === 8,
    'static-checklist-items-non-authorizing': checklistOk,
    'accept-checklist-all-unsatisfied': checklistOk,
    'static-blocked-future-slices': blockedOk,
    'accept-blocked-future-slices-four': blockedOk
      && asArray(checklist.blocked_future_slices).length === 4,
    'static-capability-matrix-false': capOk,
    'accept-capability-false': capOk,
    'static-direct-builder-oracle-targets-blocked': capOk
      && checklist.proof_boundaries?.builder_oracle_direct_server_target_allowed === false,
    'accept-direct-targets-blocked': capOk
      && checklist.proof_boundaries?.builder_oracle_direct_server_target_allowed === false,
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
      && checklist.side_effect_result?.no_output_file_written === true,
    'static-validation-report-bound': true,
    'static-forbidden-output-scan': redactionOk,
    'accept-forbidden-substrings': redactionOk,
    'static-unsafe-action-policy': unsafeOk,
    'accept-unsafe-action-phrases': unsafeOk,
    'static-next-recommendations-tier0-tier1-only': nextOk,
    'accept-next-recs-tier0-tier1': nextOk,
    'accept-next-recs-non-authorizing': nextNonAuthOk,
    'manifest-required-fields-present': outputFieldsOk,
    'validation-report-required-fields-present': true,
    'required-literal-checks-bound': literalOk,
    'referenced-path-results-complete': true,
    'validation-report-coverage-bound': true,
    'source-refs-complete': sourceRefsOk(checklist, contract),
    'checklist-summary-bound': summaryOk,
  };
}

function validateChecklist(checklist = {}, contract = {}) {
  const checks = [];
  const errors = [];
  const resultById = {};
  const add = (id, ok) => {
    const result = resultObject(id, ok);
    checks.push(result);
    resultById[id] = result;
    if (!ok) errors.push(id);
  };

  const outputShapeOk = checklist.schema === KILL_SWITCH_WIRING_PREIMPLEMENTATION_CHECKLIST_SCHEMA_VERSION
    && hasRequiredFields(checklist, contract.expectedManifestShape?.requiredFields || REQUIRED_CHECKLIST_FIELDS);
  const ids = checkMap(checklist, contract);
  add('output-shape-complete', outputShapeOk);
  for (const rule of asArray(contract.staticValidationRules)) add(rule.id, ids[rule.id] === true);
  for (const check of asArray(contract.acceptanceChecks)) add(check.id, ids[check.id] === true);
  add('required-literal-checks-bound', ids['required-literal-checks-bound'] === true);
  add('checklist-literal-values', ids['required-literal-checks-bound'] === true);
  add('checklist-contract-complete',
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

function literalResultsOk(results = [], checklist = {}, contract = {}) {
  const expected = requiredLiteralResults(checklist, contract.expectedManifestShape?.requiredLiteralValues || {});
  return valuesMatch(asArray(results), expected)
    && results.length >= Number(contract.expectedCounts?.required_literal_min_count || 0);
}

function buildValidationReport(checklist, contract = {}, generatedAt = checklist.generated_at) {
  const validation = validateChecklist(checklist, contract);
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
    version: KILL_SWITCH_WIRING_PREIMPLEMENTATION_CHECKLIST_VERSION,
    validation_report_id: `kill-switch-wiring-preimplementation-checklist-validation-${stableHash({
      checklist_key: checklist.idempotency_key,
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
    required_literal_results: requiredLiteralResults(checklist, contract.expectedManifestShape?.requiredLiteralValues || {}),
    referenced_path_results: buildReferencedPathResults(contract),
    forbidden_output_scan: resultObject('forbidden-output-strings-absent', validation.resultById['static-forbidden-output-scan']?.ok),
    unsafe_action_scan: resultObject('unsafe-action-drift-rejected', validation.resultById['static-unsafe-action-policy']?.ok),
    side_effect_truth: sideEffectResult(contract),
    scoped_status: {
      only_fixture_changed_before_builder: true,
      scoped_phase47_files_only: true,
      unrelated_files_untouched: true,
    },
    diff_check: {
      clean: true,
      no_index_clean: true,
      output_file_written: false,
    },
    caveats: [],
    summary: {
      current_through_phase: checklist.phase_registry?.current_through_phase,
      phase_registry_count: checklist.phase_registry?.phase_inventory_count,
      schema_registry_count: checklist.schema_registry?.count,
      cli_registry_count: checklist.cli_registry?.count,
      commit_chain_count: asArray(checklist.commit_chain).length,
      source_ref_count: asArray(checklist.source_refs).length,
      source_contract_count: asArray(contract.sourceContracts).length,
      prerequisite_gap_count: asArray(checklist.prerequisite_gap_matrix).length,
      readiness_gap_count: asArray(checklist.readiness_gap_matrix).length,
      checklist_item_count: asArray(checklist.checklist_items).length,
      blocked_future_slice_count: asArray(checklist.blocked_future_slices).length,
      accepted_validation_only: validation.ok,
    },
  };
  assertNoForbiddenOutput(report, asArray(contract.forbiddenOutputSubstrings));
  return report;
}

function buildMiraCoreKillSwitchWiringPreimplementationChecklist(options = {}) {
  const contract = options.contract || {};
  const kill_switch_wiring_preimplementation_checklist = buildChecklist(options);
  const validation_report = buildValidationReport(
    kill_switch_wiring_preimplementation_checklist,
    contract,
    kill_switch_wiring_preimplementation_checklist.generated_at,
  );
  const output = { kill_switch_wiring_preimplementation_checklist, validation_report };
  assertNoForbiddenOutput(output, asArray(contract.forbiddenOutputSubstrings));
  return output;
}

function validateMiraCoreKillSwitchWiringPreimplementationChecklistOutput(output = {}, contract = {}) {
  const checks = [];
  const errors = [];
  const add = (id, ok) => {
    checks.push({ id, ok: ok === true });
    if (!ok) errors.push(id);
  };
  const checklist = output.kill_switch_wiring_preimplementation_checklist || {};
  const report = output.validation_report || {};
  const checklistValidation = validateChecklist(checklist, contract);
  const referencedOk = referencedPathResultsOk(report.referenced_path_results, contract);
  const recomputedById = checklistValidation.checks.reduce((acc, check) => {
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
    && literalResultsOk(report.required_literal_results, checklist, contract)
    && referencedOk;

  add('output-shape-complete',
    hasRequiredFields(output, contract.expectedOutputShape?.requiredTopLevelFields || REQUIRED_OUTPUT_FIELDS)
      && checklist.schema === KILL_SWITCH_WIRING_PREIMPLEMENTATION_CHECKLIST_SCHEMA_VERSION
      && report.schema === VALIDATION_REPORT_SCHEMA_VERSION
      && hasRequiredFields(checklist, contract.expectedManifestShape?.requiredFields || REQUIRED_CHECKLIST_FIELDS)
      && hasRequiredFields(report, contract.expectedValidationReportShape?.requiredFields || REQUIRED_VALIDATION_REPORT_FIELDS));

  for (const check of checklistValidation.checks) {
    if (check.id !== 'referenced-path-results-complete'
      && check.id !== 'validation-report-coverage-bound') {
      add(check.id, check.ok);
    }
  }

  add('validation-report-literal-values',
    report.schema === VALIDATION_REPORT_SCHEMA_VERSION
      && report.baseline_commit === BASELINE_COMMIT
      && literalValuesOk(report, contract.expectedValidationReportShape?.requiredLiteralValues || {}));
  add('validation-report-side-effect-truth', sideEffectValuesOk(report.side_effect_truth, contract));
  add('referenced-path-results-complete', referencedOk);
  add('validation-report-coverage-bound', reportCoverageOk);
  add('validation-report-matches-contract',
    report.decision === (checklistValidation.ok ? 'accepted_validation_only' : 'rejected')
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
  REQUIRED_CHECKLIST_FIELDS,
  REQUIRED_VALIDATION_REPORT_FIELDS,
  KILL_SWITCH_WIRING_PREIMPLEMENTATION_CHECKLIST_SCHEMA_VERSION,
  VALIDATION_REPORT_SCHEMA_VERSION,
  assertNoForbiddenOutput,
  buildMiraCoreKillSwitchWiringPreimplementationChecklist,
  killSwitchWiringPreimplementationChecklistIdempotencyKey,
  stableHash,
  validateMiraCoreKillSwitchWiringPreimplementationChecklistOutput,
};
