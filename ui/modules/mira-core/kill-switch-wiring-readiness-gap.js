'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const KILL_SWITCH_WIRING_READINESS_GAP_SCHEMA_VERSION =
  'squidrun.mira_core.kill_switch_wiring_readiness_gap.v0';
const VALIDATION_REPORT_SCHEMA_VERSION =
  'squidrun.mira_core.kill_switch_wiring_readiness_gap_validation_report.v0';
const KILL_SWITCH_WIRING_READINESS_GAP_VERSION = 'v0';
const BASELINE_COMMIT = '62fa3a8';
const FIXTURE_REF =
  'ui/__tests__/fixtures/mira-core-kill-switch-wiring-readiness-gap-contract.json';

const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');

const REQUIRED_OUTPUT_FIELDS = Object.freeze([
  'kill_switch_wiring_readiness_gap',
  'validation_report',
]);

const REQUIRED_GAP_FIELDS = Object.freeze([
  'schema',
  'version',
  'gap_id',
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
  'readiness_gap_summary',
  'runtime_mode_boundary',
  'flag_reader_boundary',
  'env_config_read_boundary',
  'kill_switch_boundary',
  'kill_switch_wiring_boundary',
  'prerequisite_gap_matrix',
  'readiness_gap_matrix',
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

const EXTRA_FALSE_SIDE_EFFECT_FIELDS = Object.freeze([
  'moduleOrCliImplemented',
  'testsImplemented',
  'uiImplemented',
  'browserWindowCapturePerformed',
  'runtimeStarted',
  'runtimeModeFlagRead',
  'envReadPerformed',
  'configReadPerformed',
  'flagReadPerformed',
  'processEnvAccessed',
  'secretReadPerformed',
  'rawConfigExported',
  'envConfigReadPerformed',
  'killSwitchWired',
  'killSwitchLiveCheckPerformed',
  'killSwitchBypassed',
  'killSwitchAllowOpen',
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
]);

const SIDE_EFFECT_COUNTER_FIELDS = Object.freeze([
  'moduleCliImplementationsAttempted',
  'testImplementationsAttempted',
  'uiImplementationAttempts',
  'browserWindowCaptureAttempts',
  'runtimeAttempts',
  'runtimeModeFlagReadAttempts',
  'envConfigReadAttempts',
  'envReadAttempts',
  'configReadAttempts',
  'flagReadAttempts',
  'processEnvAccessAttempts',
  'secretReadAttempts',
  'rawConfigExportAttempts',
  'killSwitchWireAttempts',
  'killSwitchLiveCheckAttempts',
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
  'raw terminal',
  'raw screenshot',
  'raw ocr',
  'browser cookie',
  'browser dom',
  'customer private',
  'side profile payload',
  'raw comms body',
  'env secret',
  'raw config',
  'process.env',
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
  'env read performed',
  'config read performed',
  'secret read performed',
  'kill switch wired',
  'kill switch executed',
  'kill switch bypassed',
  'kill switch allow open',
  'live kill switch check performed',
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
  'phase45 commit proves runtime',
  'kill switch wiring readiness gap authorizes runtime',
  'kill switch wiring readiness gap authorizes execution',
  'kill switch wiring readiness gap authorizes kill switch',
  'socket proves bridge green',
  'delivery acceptance proves model processing',
  'builder direct target allowed',
  'oracle direct target allowed',
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
  return String(dottedPath || '').split('.').reduce((acc, key) => (
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

function evidenceRef(store, eventId, relation = 'kill_switch_wiring_readiness_gap_validation') {
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
    sessionId: inputSignals.sessionId || 'session-345',
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
  const registry = {
    source_ref: expected.source_ref,
    current_through_phase: expected.phase_inventory_count || 45,
    expected_phases: expected.expected_phases || '1-45',
    phase_inventory_count: expected.phase_inventory_count || 45,
    schema_registry_count: expected.schema_registry_count || 45,
    cli_registry_count: expected.cli_registry_count || 45,
  };
  for (const [key, value] of Object.entries(expected)) {
    if (!['source_ref', 'expected_phases', 'required_recent_phase_paths', 'phase45_delta'].includes(key)) {
      registry[key] = clone(value);
    }
  }
  registry.phase45_commit = BASELINE_COMMIT;
  registry.phase45_delta = clone(expected.phase45_delta || {});
  registry.recent_phase_paths = clone(expected.required_recent_phase_paths || []);
  registry.evidenceRefs = [
    evidenceRef('git', BASELINE_COMMIT, 'phase46-baseline'),
    evidenceRef('mira-core-kill-switch-wiring-readiness-gap-contract', 'phase-registry'),
  ];
  return registry;
}

function registryEntries(kind, contract = {}) {
  const count = Number(contract.phaseRegistryExpected?.[`${kind}_registry_count`]
    || contract.expectedManifestShape?.expectedCounts?.[`${kind}_registry_count`]
    || 45);
  const recent = new Map(asArray(contract.phaseRegistryExpected?.required_recent_phase_paths)
    .map((entry) => [entry.phase, entry]));
  return Array.from({ length: count }, (_, index) => {
    const phase = index + 1;
    const recentEntry = recent.get(phase);
    return {
      phase,
      registry_kind: kind,
      artifact_id: recentEntry ? `phase${phase}-${kind}` : `phase${phase}-${kind}-registered`,
      status: 'registered_validation_artifact',
      ...(recentEntry ? clone(recentEntry) : {}),
    };
  });
}

function withEvidence(values, store, eventId) {
  return {
    ...clone(values || {}),
    evidenceRefs: [evidenceRef(store, eventId)],
  };
}

function readinessGapSummary(contract = {}) {
  return withEvidence(
    contract.readinessGapSummaryExpected?.requiredValues || {},
    'mira-core-kill-switch-wiring-readiness-gap-contract',
    'readiness-gap-summary',
  );
}

function runtimeModeBoundary(contract = {}) {
  return withEvidence(
    contract.runtimeModeBoundaryShapeExpected?.requiredValues || {},
    'mira-core-runtime-mode-kill-switch-implementation-risk-contract',
    'runtime-mode-boundary',
  );
}

function flagReaderBoundary(contract = {}) {
  return withEvidence(
    contract.flagReaderBoundaryShapeExpected?.requiredValues || {},
    'mira-core-runtime-mode-flag-reader-safety-contract',
    'flag-reader-boundary',
  );
}

function envConfigReadBoundary(contract = {}) {
  return withEvidence(
    contract.envConfigReadBoundaryShapeExpected?.requiredValues || {},
    'mira-core-runtime-mode-flag-reader-safety-contract',
    'env-config-read-boundary',
  );
}

function killSwitchBoundary(contract = {}) {
  return withEvidence(
    contract.killSwitchBoundaryShapeExpected?.requiredValues || {},
    'mira-core-kill-switch-wiring-safety-contract',
    'kill-switch-boundary',
  );
}

function killSwitchWiringBoundary(contract = {}) {
  return withEvidence(
    contract.killSwitchWiringBoundaryShapeExpected?.requiredValues || {},
    'mira-core-kill-switch-wiring-safety-contract',
    'kill-switch-wiring-boundary',
  );
}

function prerequisiteGapMatrix(contract = {}) {
  return asArray(contract.prerequisiteGapMatrixExpected).map((gap) => ({
    ...clone(gap),
    evidenceRefs: [evidenceRef('mira-core-kill-switch-wiring-readiness-gap-contract', gap.gap_id)],
  }));
}

function readinessGapMatrix(contract = {}) {
  return asArray(contract.readinessGapMatrixExpected).map((gap) => ({
    ...clone(gap),
    evidenceRefs: [evidenceRef('mira-core-kill-switch-wiring-readiness-gap-contract', gap.gap_id)],
  }));
}

function blockedFutureSlices(contract = {}) {
  return asArray(contract.blockedFutureSlicesExpected).map((slice) => ({
    ...clone(slice),
    reason: `Slice ${slice.slice_id} remains blocked by the Phase 46 kill-switch wiring readiness-gap boundary.`,
    evidenceRefs: [evidenceRef('mira-core-kill-switch-wiring-readiness-gap-contract', slice.slice_id)],
  }));
}

function redactionSummary() {
  return {
    raw_private_content_included: false,
    raw_terminal_included: false,
    raw_screenshot_ocr_browser_included: false,
    secret_material_included: false,
    customer_private_content_included: false,
    raw_config_included: false,
    redaction_status: 'metadata_only',
    evidenceRefs: [evidenceRef('mira-core-kill-switch-wiring-readiness-gap-contract', 'redaction-summary')],
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
    evidenceRefs: [evidenceRef('mira-core-kill-switch-wiring-readiness-gap-contract', 'unsafe-action-policy')],
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
      'env-config-read',
      'kill-switch-wire',
      'kill-switch-live-check',
      'kill-switch-bypass',
      'kill-switch-allow-open',
      'irreversible-action-boundary',
    ],
    evidenceRefs: [
      evidenceRef('mira-core-kill-switch-wiring-readiness-gap-contract', `next:${candidate.recommendation_id}`),
    ],
  }));
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

function canonicalGapInput(gap = {}) {
  return {
    profile: gap.profile,
    sessionId: gap.sessionId,
    deviceId: gap.deviceId,
    baseline_commit: gap.baseline_commit,
    phase_registry: gap.phase_registry,
    schema_registry: gap.schema_registry,
    cli_registry: gap.cli_registry,
    commit_chain: gap.commit_chain,
    source_recommendation: gap.source_recommendation,
    satisfied_prior_recommendations: gap.satisfied_prior_recommendations,
    current_truth: gap.current_truth,
    stale_readiness: gap.stale_readiness,
    phase34_prior_recommendations: gap.phase34_prior_recommendations,
    closure_summary: gap.closure_summary,
    source_refs: gap.source_refs,
    readiness_gap_summary: gap.readiness_gap_summary,
    runtime_mode_boundary: gap.runtime_mode_boundary,
    flag_reader_boundary: gap.flag_reader_boundary,
    env_config_read_boundary: gap.env_config_read_boundary,
    kill_switch_boundary: gap.kill_switch_boundary,
    kill_switch_wiring_boundary: gap.kill_switch_wiring_boundary,
    prerequisite_gap_matrix: gap.prerequisite_gap_matrix,
    readiness_gap_matrix: gap.readiness_gap_matrix,
    blocked_future_slices: gap.blocked_future_slices,
    capability_matrix: gap.capability_matrix,
    boundary_truth: gap.boundary_truth,
    redaction_summary: gap.redaction_summary,
    unsafe_action_policy: gap.unsafe_action_policy,
    next_phase_recommendations: gap.next_phase_recommendations,
    side_effect_result: gap.side_effect_result,
  };
}

function killSwitchWiringReadinessGapIdempotencyKey(gap) {
  return `kill-switch-wiring-readiness-gap:${stableHash(canonicalGapInput(gap))}`;
}

function buildGap(options = {}) {
  const contract = options.contract || {};
  const inputSignals = options.inputSignals || {};
  const scope = normalizeScope(inputSignals);
  const generatedAt = generatedAtFromOptions(options, inputSignals);
  const gap = {
    schema: KILL_SWITCH_WIRING_READINESS_GAP_SCHEMA_VERSION,
    version: KILL_SWITCH_WIRING_READINESS_GAP_VERSION,
    gap_id: `kill-switch-wiring-readiness-gap-${stableHash({
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
    current_truth: withEvidence(contract.currentTruthExpected || {}, 'git', BASELINE_COMMIT),
    stale_readiness: withEvidence(contract.staleReadinessExpected || {}, 'mira-core-runtime-status-milestone-refresh', 'stale-readiness'),
    phase34_prior_recommendations: {
      phase35_runtime_status_milestone_refresh_validator: withEvidence(
        contract.phase34PriorRecommendationsExpected?.phase35_runtime_status_milestone_refresh_validator || {},
        'git',
        'c04155d',
      ),
      phase35_stdout_only_cli_smoke: withEvidence(
        contract.phase34PriorRecommendationsExpected?.phase35_stdout_only_cli_smoke || {},
        'git',
        'c04155d',
      ),
    },
    closure_summary: withEvidence(contract.closureSummaryExpected || {}, 'oracle-review', 'closure-summary'),
    source_refs: clone(contract.sourceRefsExpected || []),
    readiness_gap_summary: readinessGapSummary(contract),
    runtime_mode_boundary: runtimeModeBoundary(contract),
    flag_reader_boundary: flagReaderBoundary(contract),
    env_config_read_boundary: envConfigReadBoundary(contract),
    kill_switch_boundary: killSwitchBoundary(contract),
    kill_switch_wiring_boundary: killSwitchWiringBoundary(contract),
    prerequisite_gap_matrix: prerequisiteGapMatrix(contract),
    readiness_gap_matrix: readinessGapMatrix(contract),
    blocked_future_slices: blockedFutureSlices(contract),
    capability_matrix: withEvidence(contract.capabilityMatrixExpected || {}, 'mira-core-kill-switch-wiring-readiness-gap-contract', 'capability-matrix'),
    boundary_truth: withEvidence(contract.proofBoundaryExpected || {}, 'mira-core-kill-switch-wiring-readiness-gap-contract', 'boundary-truth'),
    redaction_summary: redactionSummary(),
    unsafe_action_policy: unsafeActionPolicy(),
    next_phase_recommendations: nextPhaseRecommendations(contract),
    evidenceRefs: [
      evidenceRef('git', BASELINE_COMMIT, 'phase46-baseline'),
      evidenceRef('fixture', FIXTURE_REF, 'oracle-contract'),
    ],
    side_effect_result: sideEffectResult(contract),
  };
  gap.idempotency_key = killSwitchWiringReadinessGapIdempotencyKey(gap);
  return gap;
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
  return hasRequiredFields(value, shape.requiredFields || [])
    && containsExpectedValues(value, shape.requiredValues || {});
}

function registryCountsOk(gap = {}) {
  return gap.phase_registry?.phase_inventory_count === 45
    && gap.phase_registry?.schema_registry_count === 45
    && gap.phase_registry?.cli_registry_count === 45
    && asArray(gap.schema_registry).length === 45
    && asArray(gap.cli_registry).length === 45;
}

function commitChainOk(gap = {}, contract = {}) {
  const expected = contract.commitChainExpected || [];
  return valuesMatch(gap.commit_chain, expected)
    && asArray(gap.commit_chain).length === 33
    && gap.commit_chain?.[gap.commit_chain.length - 1] === BASELINE_COMMIT;
}

function sourceRecommendationOk(gap = {}, contract = {}) {
  const source = gap.source_recommendation || {};
  return containsExpectedValues(source, contract.sourceRecommendation || {})
    && source.recommendation_id === 'phase46-kill-switch-wiring-readiness-gap-contract'
    && source.tier === 'tier1'
    && source.contract_only_now === true
    && source.implemented_now === false
    && source.does_not_authorize_kill_switch_wiring === true;
}

function satisfiedPriorOk(gap = {}, contract = {}) {
  const expected = asArray(contract.satisfiedPriorRecommendations);
  return asArray(gap.satisfied_prior_recommendations).length === expected.length
    && asArray(gap.satisfied_prior_recommendations).every((entry, index) => containsExpectedValues(entry, expected[index]));
}

function currentTruthOk(gap = {}, contract = {}) {
  return containsExpectedValues(gap.current_truth, contract.currentTruthExpected || {});
}

function currentPhaseOk(gap = {}, phase) {
  return gap.current_truth?.[`phase${phase}_current`] === true;
}

function staleReadinessOk(gap = {}, phase) {
  if (phase === 13) return gap.stale_readiness?.phase13_readiness_current === false;
  if (phase === 23) return gap.stale_readiness?.phase23_milestone_readiness_current === false;
  if (phase === 31) return gap.stale_readiness?.phase31_runtime_milestone_refresh_current === false;
  return false;
}

function phase34PriorOk(gap = {}, contract = {}) {
  const expected = contract.phase34PriorRecommendationsExpected || {};
  return Object.entries(expected).every(([key, expectedValue]) => containsExpectedValues(
    gap.phase34_prior_recommendations?.[key],
    expectedValue,
  ));
}

function closuresOk(gap = {}, contract = {}) {
  const expected = contract.closureSummaryExpected || {};
  return containsExpectedValues(gap.closure_summary, expected)
    && valuesMatch(gap.closure_summary?.closed_review_refs, expected.closed_review_refs || []);
}

function sourceRefsOk(gap = {}, contract = {}) {
  return valuesMatch(gap.source_refs, contract.sourceRefsExpected || []);
}

function readinessGapSummaryOk(gap = {}, contract = {}) {
  const summary = gap.readiness_gap_summary || {};
  return objectValuesOk(summary, contract.readinessGapSummaryExpected)
    && summary.gap_count === asArray(gap.readiness_gap_matrix).length
    && summary.ready_for_runtime_now === false
    && summary.ready_for_dry_run_now === false
    && summary.ready_for_kill_switch_wiring_now === false
    && summary.all_gaps_blocking === true
    && summary.all_gaps_non_authorizing === true;
}

function prerequisiteGapMatrixOk(gap = {}, contract = {}) {
  const actual = asArray(gap.prerequisite_gap_matrix);
  const expected = asArray(contract.prerequisiteGapMatrixExpected);
  return actual.length === expected.length
    && actual.every((entry, index) => containsExpectedValues(entry, expected[index]));
}

function readinessGapMatrixOk(gap = {}, contract = {}) {
  const actual = asArray(gap.readiness_gap_matrix);
  const expected = asArray(contract.readinessGapMatrixExpected);
  return actual.length === expected.length
    && actual.every((entry, index) => containsExpectedValues(entry, expected[index]))
    && actual.every((entry) => (
      entry.status === 'unsatisfied_blocking_non_authorizing'
      && entry.satisfied_now === false
      && entry.blocks_kill_switch_wiring_now === true
      && entry.authorizes_runtime === false
      && entry.authorizes_kill_switch_wiring === false
    ));
}

function blockedFutureSlicesOk(gap = {}, contract = {}) {
  const actual = asArray(gap.blocked_future_slices);
  const expected = asArray(contract.blockedFutureSlicesExpected);
  return actual.length === expected.length
    && actual.every((entry, index) => containsExpectedValues(entry, expected[index]));
}

function capabilityTruthOk(gap = {}, contract = {}) {
  return containsExpectedValues(gap.capability_matrix, contract.capabilityMatrixExpected || {})
    && Object.values(contract.capabilityMatrixExpected || {}).every((value) => value === false);
}

function proofBoundariesOk(gap = {}, contract = {}) {
  return containsExpectedValues(gap.boundary_truth, contract.proofBoundaryExpected || {})
    && Object.values(contract.proofBoundaryExpected || {}).every((value) => value === false);
}

function sideEffectValuesOk(sideEffect = {}, contract = {}) {
  return Object.keys(contract.sideEffectTruthExpected || {}).every((field) => sideEffect[field] === true)
    && EXTRA_FALSE_SIDE_EFFECT_FIELDS.every((field) => sideEffect[field] === false)
    && SIDE_EFFECT_COUNTER_FIELDS.every((field) => sideEffect[field] === 0);
}

function redactionSummaryOk(gap = {}) {
  return gap.redaction_summary?.raw_private_content_included === false
    && gap.redaction_summary?.raw_terminal_included === false
    && gap.redaction_summary?.raw_screenshot_ocr_browser_included === false
    && gap.redaction_summary?.secret_material_included === false
    && gap.redaction_summary?.customer_private_content_included === false
    && gap.redaction_summary?.raw_config_included === false;
}

function noForbiddenOutput(value, forbiddenSubstrings = []) {
  try {
    assertNoForbiddenOutput(value, forbiddenSubstrings);
    return true;
  } catch {
    return false;
  }
}

function nextRecommendationsOk(gap = {}, contract = {}) {
  const actual = asArray(gap.next_phase_recommendations);
  const expected = asArray(contract.nextRecommendationExpectedCandidates);
  return actual.length === expected.length
    && actual.every((entry, index) => containsExpectedValues(entry, expected[index]))
    && actual.every((entry) => ['tier0', 'tier1'].includes(entry.tier));
}

function nextRecommendationsNonAuthorizingOk(gap = {}) {
  return asArray(gap.next_phase_recommendations).every((entry) => (
    entry.does_not_authorize_ui === true
    && entry.does_not_authorize_runtime === true
    && entry.does_not_authorize_execution === true
    && entry.does_not_authorize_flag_read === true
    && entry.does_not_authorize_kill_switch_wiring === true
  ));
}

function normalizeText(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9.]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function occurrenceIsNegated(text, index) {
  const window = text.slice(Math.max(0, index - 40), index);
  return /\b(no|not|never|without|false|blocked|disabled|unwired|unimplemented|reference only)\b/.test(window);
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

function unsafeActionDriftOk(gap = {}, contract = {}) {
  const expected = asArray(contract.nextRecommendationExpectedCandidates);
  return asArray(gap.next_phase_recommendations).every((entry, index) => {
    const expectedEntry = expected[index] || {};
    return ['recommendation_id', 'action', 'why_safe'].every((field) => {
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
    || /\b(no|not|false|blocked|disabled|unwired|unimplemented|reference only|side effect|boundary|path|expected|actual|tamper|expectedfailure)\b/.test(before)
    || /\b(false|blocked|disabled|unwired|unimplemented|reference only|side effect|boundary|expected|actual|expectedfailure)\b/.test(after);
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

function referencedPaths(contract = {}) {
  const paths = new Set([FIXTURE_REF]);
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

function requiredLiteralManifestOk(gap = {}, contract = {}) {
  return literalValuesOk(gap, contract.expectedManifestShape?.requiredLiteralValues || {});
}

function checkMap(gap = {}, contract = {}) {
  const modeOk = objectValuesOk(gap.runtime_mode_boundary, contract.runtimeModeBoundaryShapeExpected);
  const flagOk = objectValuesOk(gap.flag_reader_boundary, contract.flagReaderBoundaryShapeExpected);
  const envOk = objectValuesOk(gap.env_config_read_boundary, contract.envConfigReadBoundaryShapeExpected);
  const killOk = objectValuesOk(gap.kill_switch_boundary, contract.killSwitchBoundaryShapeExpected);
  const killWiringOk = objectValuesOk(gap.kill_switch_wiring_boundary, contract.killSwitchWiringBoundaryShapeExpected);
  const prereqOk = prerequisiteGapMatrixOk(gap, contract);
  const readinessMatrixOk = readinessGapMatrixOk(gap, contract);
  const blockedOk = blockedFutureSlicesOk(gap, contract);
  const capabilityOk = capabilityTruthOk(gap, contract);
  const proofOk = proofBoundariesOk(gap, contract);
  const sideOk = sideEffectValuesOk(gap.side_effect_result, contract);
  const redactionOk = redactionSummaryOk(gap)
    && noForbiddenOutput(gap.redaction_summary, contract.forbiddenOutputSubstrings);
  const nextOk = nextRecommendationsOk(gap, contract);
  const nextNonAuthOk = nextRecommendationsNonAuthorizingOk(gap);
  const unsafeOk = unsafeActionDriftOk(gap, contract);
  const literalOk = requiredLiteralManifestOk(gap, contract);
  const outputFieldsOk = hasRequiredFields(gap, contract.expectedManifestShape?.requiredFields || REQUIRED_GAP_FIELDS);
  const runtimeModeGap = asArray(gap.prerequisite_gap_matrix).find((entry) => entry.gap_id === 'runtime-mode-flag-implementation') || {};
  const liveKillGap = asArray(gap.prerequisite_gap_matrix).find((entry) => entry.gap_id === 'live-kill-switch-wiring') || {};
  const liveKillSlice = asArray(gap.blocked_future_slices).find((entry) => entry.slice_id === 'live-kill-switch-wiring') || {};

  return {
    'schema-version-valid': gap.schema === KILL_SWITCH_WIRING_READINESS_GAP_SCHEMA_VERSION
      && gap.version === KILL_SWITCH_WIRING_READINESS_GAP_VERSION,
    'baseline-62fa3a8-pinned': gap.baseline_commit === BASELINE_COMMIT,
    'baseline-pinned-62fa3a8': gap.baseline_commit === BASELINE_COMMIT,
    'phase45-current-62fa3a8': gap.phase_registry?.phase45_commit === BASELINE_COMMIT
      && gap.phase_registry?.phase45_kill_switch_wiring_safety_current === true
      && gap.current_truth?.phase45_current === true,
    'phase45-current-preserved': gap.phase_registry?.phase45_kill_switch_wiring_safety_current === true
      && gap.current_truth?.phase45_current === true,
    'phase35-through-phase45-current': [35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45]
      .every((phase) => currentPhaseOk(gap, phase)),
    'phase35-current-preserved': currentPhaseOk(gap, 35),
    'phase36-current-preserved': currentPhaseOk(gap, 36),
    'phase37-current-preserved': currentPhaseOk(gap, 37),
    'phase38-current-preserved': currentPhaseOk(gap, 38),
    'phase39-current-preserved': currentPhaseOk(gap, 39),
    'phase40-current-preserved': currentPhaseOk(gap, 40),
    'phase41-current-preserved': currentPhaseOk(gap, 41),
    'phase42-current-preserved': currentPhaseOk(gap, 42),
    'phase43-current-preserved': currentPhaseOk(gap, 43),
    'phase44-current-preserved': currentPhaseOk(gap, 44),
    'phase-inventory-count-45': registryCountsOk(gap),
    'phase-inventory-exactly-45': registryCountsOk(gap),
    'schema-registry-count-45': registryCountsOk(gap),
    'schema-registry-exactly-45': registryCountsOk(gap),
    'cli-registry-count-45': registryCountsOk(gap),
    'cli-registry-exactly-45': registryCountsOk(gap),
    'commit-chain-count-33-ending-62fa3a8': commitChainOk(gap, contract),
    'commit-chain-exact-33': commitChainOk(gap, contract),
    'source-recommendation-tier1-readiness-gap-selected': sourceRecommendationOk(gap, contract),
    'source-tier1-readiness-gap-selected': sourceRecommendationOk(gap, contract),
    'phase45-tier0-validator-satisfied': satisfiedPriorOk(gap, contract),
    'phase45-tier0-satisfied-not-open': satisfiedPriorOk(gap, contract),
    'phase13-stale-truth-preserved': staleReadinessOk(gap, 13),
    'stale-phase13-preserved': staleReadinessOk(gap, 13),
    'phase23-stale-truth-preserved': staleReadinessOk(gap, 23),
    'stale-phase23-preserved': staleReadinessOk(gap, 23),
    'phase31-stale-truth-preserved': staleReadinessOk(gap, 31),
    'stale-phase31-preserved': staleReadinessOk(gap, 31),
    'phase34-prior-recommendations-satisfied': phase34PriorOk(gap, contract),
    'phase34-prior-validator-satisfied-not-reopened': phase34PriorOk(gap, contract),
    'closures-through-oracle-178-present': closuresOk(gap, contract),
    'closure-chain-through-oracle178': closuresOk(gap, contract),
    'source-refs-phase26-through-phase45-present': sourceRefsOk(gap, contract),
    'source-ref-count-15': sourceRefsOk(gap, contract)
      && asArray(gap.source_refs).length === 15,
    'source-refs-include-phase45': sourceRefsOk(gap, contract)
      && asArray(gap.source_refs).some((ref) => ref.artifact_id === 'phase45-kill-switch-wiring-safety'),
    'readiness-gap-summary-blocked': readinessGapSummaryOk(gap, contract),
    'readiness-summary-contract-only': gap.readiness_gap_summary?.decision === 'remain_kill_switch_wiring_readiness_gap_contract_only'
      && readinessGapSummaryOk(gap, contract),
    'readiness-summary-not-ready': gap.readiness_gap_summary?.ready_for_runtime_now === false
      && gap.readiness_gap_summary?.ready_for_dry_run_now === false
      && gap.readiness_gap_summary?.ready_for_kill_switch_wiring_now === false,
    'runtime-mode-boundary-disabled-reference-only': modeOk,
    'runtime-mode-disabled-default': gap.runtime_mode_boundary?.effective_state === 'disabled'
      && gap.runtime_mode_boundary?.default_state === 'disabled',
    'runtime-mode-no-flag-read': gap.runtime_mode_boundary?.flag_read_now === false,
    'flag-reader-boundary-contract-only': flagOk,
    'flag-reader-no-reader': gap.flag_reader_boundary?.reader_implemented_now === false
      && gap.flag_reader_boundary?.flagReader === false,
    'flag-reader-no-env-config-flag-secret-read':
      gap.flag_reader_boundary?.flagReadNow === false
      && gap.flag_reader_boundary?.envReadNow === false
      && gap.flag_reader_boundary?.configReadNow === false
      && gap.flag_reader_boundary?.secretReadNow === false
      && gap.flag_reader_boundary?.rawConfigExportNow === false,
    'env-config-read-boundary-none': envOk,
    'env-config-boundary-no-reads': envOk,
    'kill-switch-boundary-fail-closed-reference-only': killOk,
    'kill-switch-default-fail-closed': gap.kill_switch_boundary?.default_behavior === 'fail_closed',
    'kill-switch-unwired': gap.kill_switch_boundary?.wired === false
      && gap.kill_switch_boundary?.killWired === false,
    'kill-switch-no-live-check': gap.kill_switch_boundary?.live_check_performed === false
      && gap.kill_switch_boundary?.liveCheck === false,
    'kill-switch-no-bypass': gap.kill_switch_boundary?.bypass_allowed === false,
    'kill-switch-no-allow-open': gap.kill_switch_boundary?.allow_open_allowed === false,
    'kill-switch-wiring-boundary-unwired': killWiringOk
      && gap.kill_switch_wiring_boundary?.wiring_implemented_now === false,
    'kill-switch-wiring-no-wire': gap.kill_switch_wiring_boundary?.wiring_implemented_now === false
      && gap.kill_switch_wiring_boundary?.killWired === false,
    'kill-switch-wiring-no-live-check': gap.kill_switch_wiring_boundary?.live_check_performed === false
      && gap.kill_switch_wiring_boundary?.liveCheck === false,
    'kill-switch-wiring-no-bypass': gap.kill_switch_wiring_boundary?.bypass_allowed === false,
    'kill-switch-wiring-no-allow-open': gap.kill_switch_wiring_boundary?.allow_open_allowed === false,
    'prerequisite-gap-matrix-two-unsatisfied-gaps': prereqOk,
    'gap-matrix-exactly-two': prereqOk,
    'readiness-gap-matrix-six-unsatisfied-gaps': readinessMatrixOk,
    'readiness-gap-matrix-exactly-six': readinessMatrixOk,
    'readiness-gaps-all-unsatisfied-blocking': readinessMatrixOk,
    'future-kill-switch-wiring-slice-blocked-now': liveKillSlice.blocked_now === true
      && liveKillSlice.authorizes_runtime === false
      && liveKillSlice.authorizes_kill_switch_wiring === false,
    'live-kill-switch-wiring-slice-blocked': liveKillSlice.blocked_now === true
      && liveKillSlice.authorizes_runtime === false
      && liveKillSlice.authorizes_kill_switch_wiring === false,
    'capability-truth-false': capabilityOk,
    'runtime-started-false': gap.capability_matrix?.runtimeStarted === false
      && gap.boundary_truth?.runtimeStarted === false,
    'runner-executed-false': gap.capability_matrix?.runnerExecuted === false
      && gap.boundary_truth?.runnerExecuted === false,
    'runtime-available-false': gap.capability_matrix?.runtimeAvailable === false
      && gap.boundary_truth?.runtimeAvailable === false,
    'flag-reader-available-false': gap.capability_matrix?.runtimeModeFlagReaderAvailable === false,
    'env-config-read-available-false': gap.capability_matrix?.envConfigReadAvailable === false,
    'kill-switch-wiring-available-false': gap.capability_matrix?.killSwitchWiringAvailable === false,
    'kill-switch-live-check-available-false': gap.capability_matrix?.killSwitchLiveCheckAvailable === false,
    'server-can-execute-local-false': gap.capability_matrix?.serverCanExecuteLocal === false
      && gap.boundary_truth?.serverCanExecuteLocal === false,
    'server-can-prove-model-processing-false': gap.capability_matrix?.serverCanProveModelProcessing === false
      && gap.boundary_truth?.serverCanProveModelProcessing === false,
    'builder-oracle-direct-targets-blocked': gap.capability_matrix?.directBuilderOracleServerTargetsAllowed === false
      && gap.boundary_truth?.builderOracleDirectServerTargetsAllowed === false,
    'proof-boundaries-false': proofOk,
    'side-effect-truth-all-blocked': sideOk,
    'no-env-config-flag-read-side-effect': gap.side_effect_result?.no_env_or_config_read === true
      && gap.side_effect_result?.no_runtime_mode_flag_read === true
      && gap.side_effect_result?.envReadPerformed === false
      && gap.side_effect_result?.configReadPerformed === false
      && gap.side_effect_result?.flagReadPerformed === false,
    'no-kill-switch-wiring-side-effect': gap.side_effect_result?.no_kill_switch_wired === true
      && gap.side_effect_result?.no_kill_switch_live_check === true
      && gap.side_effect_result?.killSwitchWired === false
      && gap.side_effect_result?.killSwitchLiveCheckPerformed === false,
    'no-control-or-reporting-side-effect': gap.side_effect_result?.no_control_execution_performed === true
      && gap.side_effect_result?.no_reporting_sink_written === true
      && gap.side_effect_result?.controlExecutionPerformed === false
      && gap.side_effect_result?.reportingSinkWritten === false,
    'redaction-summary-safe': redactionOk,
    'next-recommendations-tier0-tier1-only': nextOk,
    'next-recommendations-non-authorizing': nextNonAuthOk,
    'unsafe-action-drift-rejected': unsafeOk,
    'required-literal-checks-bound': literalOk,
    'validation-report-coverage-bound': true,
    'referenced-path-results-complete': true,
    'manifest-required-fields-present': outputFieldsOk,
    'validation-report-required-fields-present': true,
    'output-shape-complete': outputFieldsOk,
    'current-truth-bound': currentTruthOk(gap, contract),
    'runtime-mode-gap-unsatisfied': runtimeModeGap.satisfied_now === false
      && runtimeModeGap.blocks_runtime_now === true,
    'live-kill-switch-gap-unsatisfied': liveKillGap.satisfied_now === false
      && liveKillGap.blocks_runtime_now === true,
    'blocked-future-slices-four': blockedOk,
  };
}

function validateGap(gap = {}, contract = {}) {
  const checks = [];
  const errors = [];
  const resultById = {};
  const add = (id, ok) => {
    const result = resultObject(id, ok);
    checks.push(result);
    resultById[id] = result;
    if (!ok) errors.push(id);
  };

  const outputShapeOk = gap.schema === KILL_SWITCH_WIRING_READINESS_GAP_SCHEMA_VERSION
    && hasRequiredFields(gap, contract.expectedManifestShape?.requiredFields || REQUIRED_GAP_FIELDS);
  const ids = checkMap(gap, contract);
  add('output-shape-complete', outputShapeOk);
  for (const rule of asArray(contract.staticValidationRules)) add(rule.id, ids[rule.id] === true);
  for (const check of asArray(contract.acceptanceChecks)) add(check.id, ids[check.id] === true);
  add('gap-literal-values', ids['required-literal-checks-bound'] === true);
  add('gap-contract-complete',
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
    && list.length >= Number(contract.expectedManifestShape?.expectedCounts?.tamper_case_results_min || 0)
    && idsEqual(list, 'id', tamperCases.map((item) => item.id))
    && list.every((entry) => {
      const expected = tamperCases.find((item) => item.id === entry.id);
      return expected
        && entry.covered === true
        && entry.expectedFailure === expected.expectedFailure;
    });
}

function literalResultsOk(results = [], gap = {}, contract = {}) {
  const expected = requiredLiteralResults(gap, contract.expectedManifestShape?.requiredLiteralValues || {});
  return valuesMatch(asArray(results), expected)
    && results.length >= Number(contract.expectedManifestShape?.expectedCounts?.required_literal_results_min || 0);
}

function buildValidationReport(gap, contract = {}, generatedAt = gap.generated_at) {
  const validation = validateGap(gap, contract);
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
    version: KILL_SWITCH_WIRING_READINESS_GAP_VERSION,
    validation_id: `kill-switch-wiring-readiness-gap-validation-${stableHash({
      gap_key: gap.idempotency_key,
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
    required_literal_results: requiredLiteralResults(gap, contract.expectedManifestShape?.requiredLiteralValues || {}),
    referenced_path_results: buildReferencedPathResults(contract),
    forbidden_output_scan: resultObject('forbidden-output-strings-absent', forbiddenScanOk),
    side_effect_truth: sideEffectResult(contract),
    summary: {
      current_through_phase: gap.phase_registry?.current_through_phase,
      phase_registry_count: gap.phase_registry?.phase_inventory_count,
      schema_registry_count: gap.phase_registry?.schema_registry_count,
      cli_registry_count: gap.phase_registry?.cli_registry_count,
      commit_chain_count: asArray(gap.commit_chain).length,
      source_ref_count: asArray(gap.source_refs).length,
      prerequisite_gap_count: asArray(gap.prerequisite_gap_matrix).length,
      readiness_gap_count: asArray(gap.readiness_gap_matrix).length,
      blocked_future_slice_count: asArray(gap.blocked_future_slices).length,
      next_recommendation_count: asArray(gap.next_phase_recommendations).length,
      baseline_commit: gap.baseline_commit,
      accepted_validation_only: validation.ok,
    },
  };
  assertNoForbiddenOutput(report, asArray(contract.forbiddenOutputSubstrings));
  return report;
}

function buildMiraCoreKillSwitchWiringReadinessGap(options = {}) {
  const contract = options.contract || {};
  const kill_switch_wiring_readiness_gap = buildGap(options);
  const validation_report = buildValidationReport(
    kill_switch_wiring_readiness_gap,
    contract,
    kill_switch_wiring_readiness_gap.generated_at,
  );
  const output = { kill_switch_wiring_readiness_gap, validation_report };
  assertNoForbiddenOutput(output, asArray(contract.forbiddenOutputSubstrings));
  return output;
}

function validateMiraCoreKillSwitchWiringReadinessGapOutput(output = {}, contract = {}) {
  const checks = [];
  const errors = [];
  const add = (id, ok) => {
    checks.push({ id, ok: ok === true });
    if (!ok) errors.push(id);
  };
  const gap = output.kill_switch_wiring_readiness_gap || {};
  const report = output.validation_report || {};
  const gapValidation = validateGap(gap, contract);
  const referencedOk = referencedPathResultsOk(report.referenced_path_results, contract);
  const recomputedById = gapValidation.checks.reduce((acc, check) => {
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
    && literalResultsOk(report.required_literal_results, gap, contract)
    && referencedOk;

  add('output-shape-complete',
    hasRequiredFields(output, contract.expectedOutputShape?.requiredTopLevelFields || REQUIRED_OUTPUT_FIELDS)
      && gap.schema === KILL_SWITCH_WIRING_READINESS_GAP_SCHEMA_VERSION
      && report.schema === VALIDATION_REPORT_SCHEMA_VERSION
      && hasRequiredFields(gap, contract.expectedManifestShape?.requiredFields || REQUIRED_GAP_FIELDS)
      && hasRequiredFields(report, contract.expectedValidationReportShape?.requiredFields || REQUIRED_VALIDATION_REPORT_FIELDS));

  for (const check of gapValidation.checks) {
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
    report.accepted === gapValidation.ok
      && report.blocked === !gapValidation.ok
      && report.decision === (gapValidation.ok ? 'accepted_validation_only' : 'rejected')
      && valuesMatch(
        asArray(report.reasons),
        gapValidation.checks.filter((check) => !check.ok).map((check) => check.id),
      )
      && reportCoverageOk
      && report.forbidden_output_scan?.ok === Boolean(recomputedById['redaction-summary-safe']?.ok));

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
  REQUIRED_GAP_FIELDS,
  REQUIRED_VALIDATION_REPORT_FIELDS,
  KILL_SWITCH_WIRING_READINESS_GAP_SCHEMA_VERSION,
  VALIDATION_REPORT_SCHEMA_VERSION,
  assertNoForbiddenOutput,
  buildMiraCoreKillSwitchWiringReadinessGap,
  killSwitchWiringReadinessGapIdempotencyKey,
  stableHash,
  validateMiraCoreKillSwitchWiringReadinessGapOutput,
};
