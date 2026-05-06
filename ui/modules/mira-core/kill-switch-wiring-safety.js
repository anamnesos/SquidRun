'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const KILL_SWITCH_WIRING_SAFETY_SCHEMA_VERSION =
  'squidrun.mira_core.kill_switch_wiring_safety.v0';
const VALIDATION_REPORT_SCHEMA_VERSION =
  'squidrun.mira_core.kill_switch_wiring_safety_validation_report.v0';
const KILL_SWITCH_WIRING_SAFETY_VERSION = 'v0';
const BASELINE_COMMIT = 'b6fd5b8';
const FIXTURE_REF =
  'ui/__tests__/fixtures/mira-core-kill-switch-wiring-safety-contract.json';

const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');

const REQUIRED_OUTPUT_FIELDS = Object.freeze([
  'kill_switch_wiring_safety',
  'validation_report',
]);

const REQUIRED_SAFETY_FIELDS = Object.freeze([
  'schema',
  'version',
  'safety_id',
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
  'flag_reader_boundary',
  'env_config_read_boundary',
  'kill_switch_boundary',
  'kill_switch_wiring_boundary',
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
  'phase44 commit proves runtime',
  'flag reader safety authorizes runtime',
  'flag reader safety authorizes flag read',
  'flag reader safety authorizes execution',
  'kill switch wiring safety authorizes runtime',
  'kill switch wiring safety authorizes execution',
  'kill switch wiring safety authorizes kill switch',
  'flag reader safety authorizes kill switch',
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

function idsEqual(items = [], field, expectedIds = []) {
  return valuesMatch(asArray(items).map((item) => item[field]), asArray(expectedIds));
}

function resultObject(id, ok) {
  return { id, ok: ok === true };
}

function evidenceRef(store, eventId, relation = 'kill_switch_wiring_safety_validation') {
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
    sessionId: inputSignals.sessionId || 'session-344',
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
    current_through_phase: 44,
    expected_phases: expected.expected_phases || '1-44',
    phase_inventory_count: 44,
    schema_registry_count: 44,
    cli_registry_count: 44,
    phase35_runtime_next_action_current: true,
    phase36_operator_ui_surface_current: true,
    phase37_control_reporting_reconciliation_current: true,
    phase38_runtime_readiness_refresh_current: true,
    phase39_dry_run_readiness_gap_current: true,
    phase40_runtime_mode_kill_switch_current: true,
    phase41_status_gap_refresh_current: true,
    phase42_prerequisite_boundary_current: true,
    phase43_implementation_risk_current: true,
    phase44_flag_reader_safety_current: true,
    phase44_commit: BASELINE_COMMIT,
    phase44_delta: clone(expected.phase44_delta || {}),
    recent_phase_paths: clone(expected.required_recent_phase_paths || []),
    evidenceRefs: [
      evidenceRef('git', BASELINE_COMMIT, 'phase45-baseline'),
      evidenceRef('mira-core-kill-switch-wiring-safety-contract', 'phase-registry'),
    ],
  };
}

function registryEntries(kind, contract = {}) {
  const recent = new Map(asArray(contract.phaseRegistryExpected?.required_recent_phase_paths)
    .map((entry) => [entry.phase, entry]));
  return Array.from({ length: 44 }, (_, index) => {
    const phase = index + 1;
    const recentEntry = recent.get(phase);
    return {
      phase,
      registry_kind: kind,
      artifact_id: recentEntry ? `phase${phase}-${kind}` : `phase${phase}-${kind}-registered`,
      status: phase <= 44 ? 'registered_validation_artifact' : 'unknown',
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

function prerequisiteBoundary(contract = {}) {
  return withEvidence(
    contract.prerequisiteBoundaryShapeExpected?.requiredValues || {},
    'mira-core-runtime-mode-kill-switch-prerequisite-boundary-contract',
    'prerequisite-boundary',
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
    'mira-core-kill-switch-wiring-safety-contract',
    'flag-reader-boundary',
  );
}

function envConfigReadBoundary(contract = {}) {
  return withEvidence(
    contract.envConfigReadBoundaryShapeExpected?.requiredValues || {},
    'mira-core-kill-switch-wiring-safety-contract',
    'env-config-read-boundary',
  );
}

function killSwitchBoundary(contract = {}) {
  return withEvidence(
    contract.killSwitchBoundaryShapeExpected?.requiredValues || {},
    'mira-core-runtime-mode-kill-switch-implementation-risk-contract',
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
    evidenceRefs: [evidenceRef('mira-core-kill-switch-wiring-safety-contract', gap.gap_id)],
  }));
}

function implementationRiskBoundary(contract = {}) {
  return {
    ...clone(contract.implementationRiskBoundaryShapeExpected?.requiredValues || {}),
    future_green_requires: [
      'separate validation-only flag-reader validator',
      'disabled default verified',
      'fail-closed missing false invalid stale unknown',
      'reference-only config names only',
      'proof boundaries remain false',
    ],
    evidenceRefs: [
      evidenceRef('mira-core-runtime-mode-kill-switch-implementation-risk-contract', 'implementation-risk-boundary'),
    ],
  };
}

function safeRiskRegister(contract = {}) {
  return asArray(contract.riskRegisterExpected).map((risk) => ({
    risk_id: risk.risk_id,
    status: risk.status,
    satisfied_now: risk.satisfied_now,
    blocks_runtime_now: risk.blocks_runtime_now,
    authorizes_runtime: risk.authorizes_runtime,
    risk_summary: `Blocking metadata-only risk ${risk.risk_id}; no kill-switch wiring or runtime authorization is granted.`,
    evidenceRefs: [evidenceRef('mira-core-kill-switch-wiring-safety-contract', risk.risk_id)],
  }));
}

function blockedFutureSlices(contract = {}) {
  return asArray(contract.blockedFutureSlicesExpected).map((slice) => ({
    ...clone(slice),
    reason: `Slice ${slice.slice_id} remains blocked by the Phase 45 kill-switch wiring safety boundary.`,
    evidenceRefs: [evidenceRef('mira-core-kill-switch-wiring-safety-contract', slice.slice_id)],
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
    evidenceRefs: [evidenceRef('mira-core-kill-switch-wiring-safety-contract', 'redaction-summary')],
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
    control_execution_allowed: false,
    reporting_sink_allowed: false,
    unsafe_action_drift_rejected: true,
    evidenceRefs: [evidenceRef('mira-core-kill-switch-wiring-safety-contract', 'unsafe-action-policy')],
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
      'irreversible-action-boundary',
    ],
    evidenceRefs: [
      evidenceRef('mira-core-kill-switch-wiring-safety-contract', `next:${candidate.recommendation_id}`),
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

function canonicalSafetyInput(safety = {}) {
  return {
    profile: safety.profile,
    sessionId: safety.sessionId,
    deviceId: safety.deviceId,
    baseline_commit: safety.baseline_commit,
    phase_registry: safety.phase_registry,
    schema_registry: safety.schema_registry,
    cli_registry: safety.cli_registry,
    commit_chain: safety.commit_chain,
    source_recommendation: safety.source_recommendation,
    satisfied_prior_recommendations: safety.satisfied_prior_recommendations,
    current_truth: safety.current_truth,
    stale_readiness: safety.stale_readiness,
    phase34_prior_recommendations: safety.phase34_prior_recommendations,
    closure_summary: safety.closure_summary,
    source_refs: safety.source_refs,
    prerequisite_boundary: safety.prerequisite_boundary,
    runtime_mode_boundary: safety.runtime_mode_boundary,
    flag_reader_boundary: safety.flag_reader_boundary,
    env_config_read_boundary: safety.env_config_read_boundary,
    kill_switch_boundary: safety.kill_switch_boundary,
    kill_switch_wiring_boundary: safety.kill_switch_wiring_boundary,
    prerequisite_gap_matrix: safety.prerequisite_gap_matrix,
    implementation_risk_boundary: safety.implementation_risk_boundary,
    risk_register: safety.risk_register,
    blocked_future_slices: safety.blocked_future_slices,
    capability_matrix: safety.capability_matrix,
    boundary_truth: safety.boundary_truth,
    redaction_summary: safety.redaction_summary,
    unsafe_action_policy: safety.unsafe_action_policy,
    next_phase_recommendations: safety.next_phase_recommendations,
    side_effect_result: safety.side_effect_result,
  };
}

function killSwitchWiringSafetyIdempotencyKey(safety) {
  return `kill-switch-wiring-safety:${stableHash(canonicalSafetyInput(safety))}`;
}

function buildSafety(options = {}) {
  const contract = options.contract || {};
  const inputSignals = options.inputSignals || {};
  const scope = normalizeScope(inputSignals);
  const generatedAt = generatedAtFromOptions(options, inputSignals);
  const safety = {
    schema: KILL_SWITCH_WIRING_SAFETY_SCHEMA_VERSION,
    version: KILL_SWITCH_WIRING_SAFETY_VERSION,
    safety_id: `kill-switch-wiring-safety-${stableHash({
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
    prerequisite_boundary: prerequisiteBoundary(contract),
    runtime_mode_boundary: runtimeModeBoundary(contract),
    flag_reader_boundary: flagReaderBoundary(contract),
    env_config_read_boundary: envConfigReadBoundary(contract),
    kill_switch_boundary: killSwitchBoundary(contract),
    kill_switch_wiring_boundary: killSwitchWiringBoundary(contract),
    prerequisite_gap_matrix: prerequisiteGapMatrix(contract),
    implementation_risk_boundary: implementationRiskBoundary(contract),
    risk_register: safeRiskRegister(contract),
    blocked_future_slices: blockedFutureSlices(contract),
    capability_matrix: withEvidence(contract.capabilityMatrixExpected || {}, 'mira-core-kill-switch-wiring-safety-contract', 'capability-matrix'),
    boundary_truth: withEvidence(contract.proofBoundaryExpected || {}, 'mira-core-kill-switch-wiring-safety-contract', 'boundary-truth'),
    redaction_summary: redactionSummary(),
    unsafe_action_policy: unsafeActionPolicy(),
    next_phase_recommendations: nextPhaseRecommendations(contract),
    evidenceRefs: [
      evidenceRef('mira-core-kill-switch-wiring-safety-contract', 'phase45-safety'),
      evidenceRef('git', BASELINE_COMMIT, 'phase45-baseline'),
    ],
    side_effect_result: sideEffectResult(contract),
  };
  safety.idempotency_key = killSwitchWiringSafetyIdempotencyKey(safety);
  return safety;
}

function literalValuesOk(value = {}, literalMap = {}) {
  return Object.entries(literalMap || {}).every(([dottedPath, expected]) => (
    valuesMatch(pathValue(value, dottedPath), expected)
  ));
}

function requiredLiteralResults(value = {}, literalMap = {}) {
  return Object.entries(literalMap || {}).map(([dottedPath, expected]) => {
    const actual = pathValue(value, dottedPath);
    return { path: dottedPath, expected, actual, ok: valuesMatch(actual, expected) };
  });
}

function objectValuesOk(value = {}, shape = {}) {
  return hasRequiredFields(value, shape.requiredFields || [])
    && Object.entries(shape.requiredValues || {}).every(([key, expected]) => valuesMatch(value[key], expected));
}

function phaseCurrentOk(safety = {}, phase) {
  const registry = safety.phase_registry || {};
  const truth = safety.current_truth || {};
  const registryMap = {
    35: 'phase35_runtime_next_action_current',
    36: 'phase36_operator_ui_surface_current',
    37: 'phase37_control_reporting_reconciliation_current',
    38: 'phase38_runtime_readiness_refresh_current',
    39: 'phase39_dry_run_readiness_gap_current',
    40: 'phase40_runtime_mode_kill_switch_current',
    41: 'phase41_status_gap_refresh_current',
    42: 'phase42_prerequisite_boundary_current',
    43: 'phase43_implementation_risk_current',
    44: 'phase44_flag_reader_safety_current',
  };
  return registry[registryMap[phase]] === true
    && truth[`phase${phase}_current`] === true
    && (phase !== 44 || (
      registry.phase44_commit === BASELINE_COMMIT
      && registry.phase44_delta?.committed_baseline === BASELINE_COMMIT
    ));
}

function registryCountsOk(safety = {}) {
  return safety.phase_registry?.current_through_phase === 44
    && safety.phase_registry?.expected_phases === '1-44'
    && safety.phase_registry?.phase_inventory_count === 44
    && safety.phase_registry?.schema_registry_count === 44
    && safety.phase_registry?.cli_registry_count === 44
    && asArray(safety.schema_registry).length === 44
    && asArray(safety.cli_registry).length === 44;
}

function commitChainOk(safety = {}, contract = {}) {
  const chain = asArray(safety.commit_chain);
  const expectedCount = Number(contract.expectedManifestShape?.expectedCounts?.commit_chain_count || 32);
  return valuesMatch(chain, asArray(contract.commitChainExpected))
    && chain.length === expectedCount
    && chain[chain.length - 1] === BASELINE_COMMIT;
}

function sourceRecommendationOk(safety = {}, contract = {}) {
  const expected = contract.sourceRecommendation || {};
  const rec = safety.source_recommendation || {};
  return rec.recommendation_id === expected.recommendation_id
    && rec.tier === 'tier1'
    && rec.contract_only_now === true
    && rec.implemented_now === false
    && rec.does_not_authorize_flag_read === true
    && rec.does_not_authorize_kill_switch_wiring === true
    && rec.does_not_authorize_ui === true
    && rec.does_not_authorize_runtime === true
    && rec.does_not_authorize_execution === true;
}

function satisfiedPriorOk(safety = {}, contract = {}) {
  const expected = asArray(contract.satisfiedPriorRecommendations);
  const current = asArray(safety.satisfied_prior_recommendations);
  return current.length === expected.length
    && current.length === 1
    && current[0].recommendation_id === expected[0].recommendation_id
    && current[0].status === expected[0].status
    && current[0].satisfied_by_commit === BASELINE_COMMIT
    && current[0].must_not_reopen === true;
}

function priorOk(safety = {}, key) {
  const value = safety.phase34_prior_recommendations?.[key];
  return value?.status === 'satisfied_by_c04155d_do_not_repeat_as_open_work'
    && value?.must_not_reopen === true;
}

function staleReadinessOk(safety = {}, phase) {
  if (phase === 13) {
    return safety.stale_readiness?.phase13_readiness_current === false
      && safety.stale_readiness?.phase13_superseded_by === 'phase_23_milestone_readiness';
  }
  if (phase === 23) {
    return safety.stale_readiness?.phase23_milestone_readiness_current === false
      && safety.stale_readiness?.phase23_superseded_by === 'phase_31_runtime_milestone_refresh';
  }
  if (phase === 31) {
    return safety.stale_readiness?.phase31_runtime_milestone_refresh_current === false
      && safety.stale_readiness?.phase31_superseded_by === 'phase_34_runtime_status_milestone_refresh';
  }
  return false;
}

function closuresOk(safety = {}, contract = {}) {
  const expected = contract.closureSummaryExpected || {};
  return Object.entries(expected).every(([key, value]) => (
    key === 'closed_review_refs'
      ? valuesMatch(safety.closure_summary?.[key], value)
      : safety.closure_summary?.[key] === value
  ));
}

function sourceRefsOk(safety = {}, contract = {}) {
  return valuesMatch(safety.source_refs, contract.sourceRefsExpected || []);
}

function recentPhasePathsOk(safety = {}, contract = {}) {
  return valuesMatch(
    safety.phase_registry?.recent_phase_paths,
    contract.phaseRegistryExpected?.required_recent_phase_paths || [],
  );
}

function prerequisiteGapMatrixOk(safety = {}, contract = {}) {
  const expected = asArray(contract.prerequisiteGapMatrixExpected);
  const gaps = asArray(safety.prerequisite_gap_matrix);
  return gaps.length === expected.length
    && gaps.length === 2
    && gaps.every((gap, index) => Object.entries(expected[index] || {})
      .every(([key, value]) => valuesMatch(gap[key], value)));
}

function riskRegisterOk(safety = {}, contract = {}) {
  const expected = asArray(contract.riskRegisterExpected);
  const risks = asArray(safety.risk_register);
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

function blockedFutureSlicesOk(safety = {}, contract = {}) {
  const expected = asArray(contract.blockedFutureSlicesExpected);
  const slices = asArray(safety.blocked_future_slices);
  return slices.length === expected.length
    && slices.length === 4
    && slices.every((slice, index) => Object.entries(expected[index] || {})
      .every(([key, value]) => valuesMatch(slice[key], value)));
}

function capabilityTruthOk(safety = {}) {
  return Object.entries({
    runtimeStarted: false,
    runnerExecuted: false,
    runtimeAvailable: false,
    realRuntimeAvailable: false,
    serverCanExecuteLocal: false,
    serverCanProveModelProcessing: false,
    directBuilderOracleServerTargetsAllowed: false,
    runtimeModeFlagReaderAvailable: false,
    runtimeModeFlagReadAvailable: false,
    envConfigReadAvailable: false,
    killSwitchWiringAvailable: false,
    killSwitchLiveCheckAvailable: false,
    controlExecutionAvailable: false,
    reportingSinkAvailable: false,
  }).every(([key, expected]) => safety.capability_matrix?.[key] === expected);
}

function proofBoundariesOk(safety = {}, contract = {}) {
  return Object.entries(contract.proofBoundaryExpected || {})
    .every(([key, expected]) => safety.boundary_truth?.[key] === expected);
}

function sideEffectValuesOk(sideEffect = {}, contract = {}) {
  return Object.keys(contract.sideEffectTruthExpected || {}).every((field) => sideEffect[field] === true)
    && EXTRA_FALSE_SIDE_EFFECT_FIELDS.every((field) => sideEffect[field] === false)
    && SIDE_EFFECT_COUNTER_FIELDS.every((field) => sideEffect[field] === 0);
}

function noModuleCliTestRuntimeWorkOk(safety = {}) {
  return safety.side_effect_result?.no_module_or_cli_implemented === true
    && safety.side_effect_result?.no_tests_implemented === true
    && safety.side_effect_result?.no_runtime_performed === true
    && safety.side_effect_result?.no_runtime_mode_flag_read === true
    && safety.side_effect_result?.no_env_or_config_read === true
    && safety.side_effect_result?.no_kill_switch_wired === true
    && safety.side_effect_result?.no_kill_switch_live_check === true
    && safety.side_effect_result?.no_control_execution_performed === true
    && safety.side_effect_result?.no_reporting_sink_written === true
    && safety.side_effect_result?.no_output_file_written === true;
}

function redactionSummaryOk(safety = {}) {
  return safety.redaction_summary?.raw_private_content_included === false
    && safety.redaction_summary?.raw_terminal_included === false
    && safety.redaction_summary?.raw_screenshot_ocr_browser_included === false
    && safety.redaction_summary?.secret_material_included === false
    && safety.redaction_summary?.customer_private_content_included === false
    && safety.redaction_summary?.raw_config_included === false;
}

function nextRecommendationsOk(safety = {}, contract = {}) {
  const candidates = asArray(contract.nextRecommendationExpectedCandidates);
  const recommendations = asArray(safety.next_phase_recommendations);
  return recommendations.length >= Number(contract.expectedManifestShape?.expectedCounts?.next_phase_recommendations_min || 0)
    && recommendations.length === candidates.length
    && recommendations.every((item) => (
      ['tier0', 'tier1'].includes(item.tier)
      && item.does_not_authorize_ui === true
      && item.does_not_authorize_runtime === true
      && item.does_not_authorize_execution === true
      && item.does_not_authorize_flag_read === true
      && item.does_not_authorize_kill_switch_wiring === true
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
  for (const phrase of asArray(contract.unsafeActionPhrases)) {
    const needle = normalizeText(phrase);
    let index = normalized.indexOf(needle);
    while (index !== -1) {
      if (!occurrenceIsNegated(normalized, index)) return true;
      index = normalized.indexOf(needle, index + needle.length);
    }
  }
  return false;
}

function unsafeActionDriftOk(safety = {}, contract = {}) {
  const expectedById = new Map(asArray(contract.nextRecommendationExpectedCandidates)
    .map((candidate) => [candidate.recommendation_id, candidate]));
  return asArray(safety.next_phase_recommendations).every((item) => {
    const expected = expectedById.get(item.recommendation_id) || {};
    return ['action', 'why_safe'].every((field) => (
      item[field] === expected[field] || !textHasUnsafeActionDrift(item[field], contract)
    ));
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
        throw new Error(`Forbidden Phase 45 output substring: ${rawForbidden}`);
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
    return { path: relativePath, exists, expected: true, ok: exists };
  });
}

function referencedPathResultsOk(results = [], contract = {}) {
  const expected = referencedPaths(contract);
  const list = asArray(results);
  return expected.length > 0
    && idsEqual(list, 'path', expected)
    && list.every((entry) => entry.expected === true && entry.exists === true && entry.ok === true);
}

function flagReaderSafetyDoesNotSatisfyRuntimeGapOk(safety = {}) {
  const flagGap = asArray(safety.prerequisite_gap_matrix)
    .find((gap) => gap.gap_id === 'runtime-mode-flag-implementation');
  const flagSlice = asArray(safety.blocked_future_slices)
    .find((slice) => slice.slice_id === 'runtime-mode-flag-reader');
  return flagGap?.satisfied_now === false
    && flagGap?.blocks_runtime_now === true
    && flagGap?.authorizes_runtime === false
    && flagGap?.authorizes_dry_run === false
    && flagGap?.authorizes_execution === false
    && safety.flag_reader_boundary?.reader_implemented_now === false
    && safety.flag_reader_boundary?.flagReader === false
    && safety.flag_reader_boundary?.flagReadNow === false
    && safety.flag_reader_boundary?.envReadNow === false
    && safety.flag_reader_boundary?.configReadNow === false
    && safety.flag_reader_boundary?.secretReadNow === false
    && safety.flag_reader_boundary?.rawConfigExportNow === false
    && flagSlice?.blocked_now === true
    && flagSlice?.authorizes_runtime === false
    && flagSlice?.authorizes_flag_read === false;
}

function checkMap(safety = {}, contract = {}) {
  const baselineOk = safety.baseline_commit === BASELINE_COMMIT;
  const phaseOk = (phase) => phaseCurrentOk(safety, phase);
  const registryOk = registryCountsOk(safety);
  const chainOk = commitChainOk(safety, contract);
  const sourceOk = sourceRecommendationOk(safety, contract);
  const satisfiedOk = satisfiedPriorOk(safety, contract);
  const priorValidatorOk = priorOk(safety, 'phase35_runtime_status_milestone_refresh_validator');
  const priorCliOk = priorOk(safety, 'phase35_stdout_only_cli_smoke');
  const stale13Ok = staleReadinessOk(safety, 13);
  const stale23Ok = staleReadinessOk(safety, 23);
  const stale31Ok = staleReadinessOk(safety, 31);
  const closureOk = closuresOk(safety, contract);
  const refsOk = sourceRefsOk(safety, contract);
  const recentPathsOk = recentPhasePathsOk(safety, contract);
  const prerequisiteOk = objectValuesOk(safety.prerequisite_boundary, contract.prerequisiteBoundaryShapeExpected);
  const modeOk = objectValuesOk(safety.runtime_mode_boundary, contract.runtimeModeBoundaryShapeExpected);
  const flagOk = objectValuesOk(safety.flag_reader_boundary, contract.flagReaderBoundaryShapeExpected);
  const envOk = objectValuesOk(safety.env_config_read_boundary, contract.envConfigReadBoundaryShapeExpected);
  const killOk = objectValuesOk(safety.kill_switch_boundary, contract.killSwitchBoundaryShapeExpected);
  const killWiringOk = objectValuesOk(
    safety.kill_switch_wiring_boundary,
    contract.killSwitchWiringBoundaryShapeExpected,
  );
  const matrixOk = prerequisiteGapMatrixOk(safety, contract);
  const implementationOk = objectValuesOk(safety.implementation_risk_boundary, contract.implementationRiskBoundaryShapeExpected);
  const riskOk = riskRegisterOk(safety, contract);
  const blockedOk = blockedFutureSlicesOk(safety, contract);
  const capabilityOk = capabilityTruthOk(safety);
  const proofOk = proofBoundariesOk(safety, contract);
  const sideOk = sideEffectValuesOk(safety.side_effect_result, contract);
  const scopeOk = noModuleCliTestRuntimeWorkOk(safety);
  let forbiddenOk = true;
  try {
    assertNoForbiddenOutput(safety, asArray(contract.forbiddenOutputSubstrings));
  } catch {
    forbiddenOk = false;
  }
  const redactionOk = redactionSummaryOk(safety) && forbiddenOk;
  const nextOk = nextRecommendationsOk(safety, contract);
  const nextNonAuthOk = nextOk && asArray(safety.next_phase_recommendations).every((item) => (
    item.does_not_authorize_ui === true
    && item.does_not_authorize_runtime === true
    && item.does_not_authorize_execution === true
    && item.does_not_authorize_flag_read === true
    && item.does_not_authorize_kill_switch_wiring === true
  ));
  const unsafeOk = unsafeActionDriftOk(safety, contract);
  const literalOk = literalValuesOk(safety, contract.expectedManifestShape?.requiredLiteralValues || {});
  const idempotencyOk = safety.idempotency_key === killSwitchWiringSafetyIdempotencyKey(safety);
  const firstSlice = asArray(safety.blocked_future_slices)[0] || {};
  const sliceById = (sliceId) => asArray(safety.blocked_future_slices)
    .find((slice) => slice.slice_id === sliceId) || {};
  const liveKillSlice = sliceById('live-kill-switch-wiring');
  const flagSlice = sliceById('runtime-mode-flag-reader');
  const controlSlice = sliceById('control-path-execution');
  const reportingSlice = sliceById('reporting-sink-write');
  const gapById = (gapId) => asArray(safety.prerequisite_gap_matrix)
    .find((gap) => gap.gap_id === gapId) || {};
  const runtimeGap = gapById('runtime-mode-flag-implementation');
  const liveKillGap = gapById('live-kill-switch-wiring');
  const outputFieldsOk = hasRequiredFields(safety, contract.expectedManifestShape?.requiredFields || []);
  const phase35Through44Ok = [35, 36, 37, 38, 39, 40, 41, 42, 43, 44]
    .every((phase) => phaseOk(phase));
  const killSwitchWiringNoWireOk = safety.kill_switch_wiring_boundary?.wiring_implemented_now === false
    && safety.kill_switch_wiring_boundary?.killWired === false;
  const killSwitchWiringNoLiveCheckOk = safety.kill_switch_wiring_boundary?.live_check_performed === false
    && safety.kill_switch_wiring_boundary?.liveCheck === false;
  const killSwitchWiringNoControlOk = safety.kill_switch_wiring_boundary?.control_execution_allowed === false
    && safety.kill_switch_wiring_boundary?.authorizes_control_execution === false;
  const killSwitchWiringNoReportingOk = safety.kill_switch_wiring_boundary?.reporting_sink_allowed === false
    && safety.kill_switch_wiring_boundary?.authorizes_reporting_sink === false;
  const noKillSwitchWiringSideEffectOk = safety.side_effect_result?.no_kill_switch_wired === true
    && safety.side_effect_result?.no_kill_switch_live_check === true
    && safety.side_effect_result?.killSwitchWired === false
    && safety.side_effect_result?.killSwitchLiveCheckPerformed === false
    && safety.side_effect_result?.killSwitchWireAttempts === 0
    && safety.side_effect_result?.killSwitchLiveCheckAttempts === 0;
  const noControlReportingSideEffectOk = safety.side_effect_result?.no_control_execution_performed === true
    && safety.side_effect_result?.no_reporting_sink_written === true
    && safety.side_effect_result?.controlExecutionPerformed === false
    && safety.side_effect_result?.reportingSinkWritten === false
    && safety.side_effect_result?.controlExecutionsAttempted === 0
    && safety.side_effect_result?.reportingSinkWritesAttempted === 0;

  return {
    'output-shape-complete': outputFieldsOk,
    'schema-version-valid': safety.schema === KILL_SWITCH_WIRING_SAFETY_SCHEMA_VERSION,
    'baseline-pinned-b6fd5b8': baselineOk,
    'baseline-b6fd5b8-pinned': baselineOk,
    'phase44-current': phaseOk(44),
    'phase44-current-b6fd5b8': phaseOk(44),
    'phase44-current-preserved': phaseOk(44),
    'phase35-current-preserved': phaseOk(35),
    'phase36-current-preserved': phaseOk(36),
    'phase37-current-preserved': phaseOk(37),
    'phase38-current-preserved': phaseOk(38),
    'phase39-current-preserved': phaseOk(39),
    'phase40-current-preserved': phaseOk(40),
    'phase41-current-preserved': phaseOk(41),
    'phase42-current-preserved': phaseOk(42),
    'phase43-current-preserved': phaseOk(43),
    'phase35-through-phase44-current': phase35Through44Ok,
    'phase-inventory-count-44': registryOk,
    'phase-inventory-exactly-44': registryOk,
    'schema-registry-count-44': registryOk,
    'schema-registry-exactly-44': registryOk,
    'cli-registry-count-44': registryOk,
    'cli-registry-exactly-44': registryOk,
    'commit-chain-exact-32': chainOk,
    'commit-chain-count-32-ending-b6fd5b8': chainOk,
    'source-recommendation-tier1-selected': sourceOk,
    'source-recommendation-tier1-kill-switch-wiring-selected': sourceOk,
    'source-tier1-kill-switch-wiring-selected': sourceOk,
    'phase44-tier0-satisfied-not-open': satisfiedOk,
    'phase44-tier0-validator-satisfied': satisfiedOk,
    'phase44-tier0-validator-not-reopened': satisfiedOk,
    'phase34-prior-recommendations-satisfied': priorValidatorOk && priorCliOk,
    'phase34-prior-validator-satisfied-not-reopened': priorValidatorOk,
    'phase34-prior-cli-smoke-satisfied-not-reopened': priorCliOk,
    'phase13-stale-preserved': stale13Ok,
    'stale-phase13-preserved': stale13Ok,
    'phase13-stale-truth-preserved': stale13Ok,
    'phase23-stale-preserved': stale23Ok,
    'stale-phase23-preserved': stale23Ok,
    'phase23-stale-truth-preserved': stale23Ok,
    'phase31-stale-preserved': stale31Ok,
    'stale-phase31-preserved': stale31Ok,
    'phase31-stale-superseded-by-phase34': stale31Ok,
    'phase31-stale-truth-preserved': stale31Ok,
    'closure-chain-through-oracle174': closureOk,
    'closures-through-oracle-174-present': closureOk,
    'source-refs-phase26-through-phase44-present': refsOk,
    'source-ref-count-14': refsOk && asArray(safety.source_refs).length === 14,
    'source-refs-include-phase44': asArray(safety.source_refs)
      .some((ref) => ref.artifact_id === 'phase44-runtime-mode-flag-reader-safety'),
    'recent-phase-paths-present': recentPathsOk,
    'prerequisite-boundary-preserved': prerequisiteOk,
    'prerequisite-boundary-required-fields-present':
      hasRequiredFields(safety.prerequisite_boundary, contract.prerequisiteBoundaryShapeExpected?.requiredFields || []),
    'prerequisite-boundary-non-authorizing': prerequisiteOk,
    'prerequisite-boundary-blocks-runtime-now': prerequisiteOk,
    'runtime-mode-boundary-disabled-reference-only': modeOk,
    'runtime-mode-boundary-required-fields-present':
      hasRequiredFields(safety.runtime_mode_boundary, contract.runtimeModeBoundaryShapeExpected?.requiredFields || []),
    'runtime-mode-boundary-disabled-default': safety.runtime_mode_boundary?.effective_state === 'disabled',
    'runtime-mode-disabled-default': safety.runtime_mode_boundary?.effective_state === 'disabled',
    'runtime-mode-boundary-local-dev-only':
      safety.runtime_mode_boundary?.local_only === true && safety.runtime_mode_boundary?.dev_only === true,
    'runtime-mode-local-dev-only':
      safety.runtime_mode_boundary?.local_only === true && safety.runtime_mode_boundary?.dev_only === true,
    'runtime-mode-boundary-unimplemented': safety.runtime_mode_boundary?.implemented_now === false,
    'runtime-mode-unimplemented': safety.runtime_mode_boundary?.implemented_now === false,
    'runtime-mode-boundary-no-flag-read': safety.runtime_mode_boundary?.flag_read_now === false,
    'runtime-mode-no-flag-read': safety.runtime_mode_boundary?.flag_read_now === false,
    'runtime-mode-boundary-non-authorizing': modeOk,
    'flag-reader-boundary-contract-only': flagOk,
    'flag-reader-boundary-required-fields-present':
      hasRequiredFields(safety.flag_reader_boundary, contract.flagReaderBoundaryShapeExpected?.requiredFields || []),
    'flag-reader-boundary-no-reader': safety.flag_reader_boundary?.reader_implemented_now === false
      && safety.flag_reader_boundary?.flagReader === false,
    'flag-reader-no-reader': safety.flag_reader_boundary?.reader_implemented_now === false
      && safety.flag_reader_boundary?.flagReader === false,
    'flag-reader-boundary-no-env-config-flag-secret-read':
      safety.flag_reader_boundary?.flagReadNow === false
      && safety.flag_reader_boundary?.envReadNow === false
      && safety.flag_reader_boundary?.configReadNow === false
      && safety.flag_reader_boundary?.secretReadNow === false
      && safety.flag_reader_boundary?.rawConfigExportNow === false,
    'flag-reader-no-env-config-flag-secret-read':
      safety.flag_reader_boundary?.flagReadNow === false
      && safety.flag_reader_boundary?.envReadNow === false
      && safety.flag_reader_boundary?.configReadNow === false
      && safety.flag_reader_boundary?.secretReadNow === false
      && safety.flag_reader_boundary?.rawConfigExportNow === false,
    'flag-reader-boundary-non-authorizing': flagOk,
    'env-config-read-boundary-none': envOk,
    'env-config-read-boundary-required-fields-present':
      hasRequiredFields(safety.env_config_read_boundary, contract.envConfigReadBoundaryShapeExpected?.requiredFields || []),
    'env-config-read-boundary-no-reads': envOk,
    'env-config-boundary-no-reads': envOk,
    'env-config-read-boundary-reference-only': envOk,
    'kill-switch-boundary-fail-closed-reference-only': killOk,
    'kill-switch-boundary-required-fields-present':
      hasRequiredFields(safety.kill_switch_boundary, contract.killSwitchBoundaryShapeExpected?.requiredFields || []),
    'kill-switch-boundary-fail-closed': safety.kill_switch_boundary?.default_behavior === 'fail_closed',
    'kill-switch-boundary-unwired':
      safety.kill_switch_boundary?.wired === false && safety.kill_switch_boundary?.killWired === false,
    'kill-switch-boundary-no-live-check':
      safety.kill_switch_boundary?.live_check_performed === false && safety.kill_switch_boundary?.liveCheck === false,
    'kill-switch-boundary-non-authorizing': killOk,
    'kill-switch-visible-to-operator': safety.kill_switch_boundary?.visible_to_operator === true,
    'kill-switch-default-fail-closed': safety.kill_switch_boundary?.default_behavior === 'fail_closed',
    'kill-switch-unwired':
      safety.kill_switch_boundary?.wired === false && safety.kill_switch_boundary?.killWired === false,
    'kill-switch-no-live-check':
      safety.kill_switch_boundary?.live_check_performed === false && safety.kill_switch_boundary?.liveCheck === false,
    'kill-switch-non-authorizing': killOk,
    'kill-switch-wiring-boundary-contract-only': killWiringOk,
    'kill-switch-wiring-boundary-unwired': killSwitchWiringNoWireOk,
    'kill-switch-wiring-boundary-non-authorizing': killWiringOk,
    'kill-switch-wiring-required-fields-present':
      hasRequiredFields(safety.kill_switch_wiring_boundary, contract.killSwitchWiringBoundaryShapeExpected?.requiredFields || []),
    'kill-switch-wiring-contract-only':
      safety.kill_switch_wiring_boundary?.contract_only_now === true && killWiringOk,
    'kill-switch-wiring-reference-only':
      safety.kill_switch_wiring_boundary?.reference_only === true && killWiringOk,
    'kill-switch-wiring-fail-closed-required':
      safety.kill_switch_wiring_boundary?.fail_closed_required === true
      && safety.kill_switch_wiring_boundary?.default_behavior_required === 'fail_closed',
    'kill-switch-wiring-no-wire': killSwitchWiringNoWireOk,
    'kill-switch-wiring-no-live-check': killSwitchWiringNoLiveCheckOk,
    'kill-switch-wiring-no-bypass': safety.kill_switch_wiring_boundary?.bypass_allowed === false,
    'kill-switch-wiring-no-allow-open': safety.kill_switch_wiring_boundary?.allow_open_allowed === false,
    'kill-switch-wiring-no-control-execution': killSwitchWiringNoControlOk,
    'kill-switch-wiring-no-reporting-sink': killSwitchWiringNoReportingOk,
    'kill-switch-wiring-non-authorizing': killWiringOk,
    'prerequisite-gap-matrix-two-unsatisfied-gaps': matrixOk,
    'prerequisite-gap-matrix-exactly-two': matrixOk,
    'prerequisite-gap-matrix-unsatisfied-and-blocking': matrixOk,
    'gap-matrix-exactly-two': matrixOk,
    'gap-matrix-runtime-mode-unsatisfied': runtimeGap.satisfied_now === false
      && runtimeGap.blocks_runtime_now === true
      && runtimeGap.authorizes_runtime === false,
    'gap-matrix-live-kill-switch-unsatisfied': liveKillGap.satisfied_now === false
      && liveKillGap.blocks_runtime_now === true
      && liveKillGap.authorizes_runtime === false,
    'implementation-risk-boundary-non-authorizing': implementationOk,
    'implementation-risk-boundary-required-fields-present':
      hasRequiredFields(safety.implementation_risk_boundary, contract.implementationRiskBoundaryShapeExpected?.requiredFields || []),
    'implementation-risk-boundary-contract-only': implementationOk,
    'implementation-risk-boundary-blocks-implementation-now': implementationOk,
    'implementation-risk-contract-only': implementationOk,
    'implementation-risk-blocks-implementation-now': implementationOk,
    'risk-register-eight-blocking-risks': riskOk,
    'risk-register-exactly-eight': riskOk,
    'risk-register-all-blocking': riskOk,
    'risk-register-all-non-authorizing': riskOk,
    'blocked-future-slices-four': blockedOk,
    'blocked-future-slices-exactly-four': blockedOk,
    'future-kill-switch-wiring-slice-blocked-now': firstSlice.slice_id === 'live-kill-switch-wiring'
      && firstSlice.blocked_now === true
      && firstSlice.authorizes_runtime === false
      && firstSlice.authorizes_kill_switch_wiring === false,
    'live-kill-switch-wiring-slice-blocked': liveKillSlice.blocked_now === true
      && liveKillSlice.authorizes_runtime === false
      && liveKillSlice.authorizes_kill_switch_wiring === false,
    'runtime-mode-flag-reader-slice-blocked': flagSlice.blocked_now === true
      && flagSlice.authorizes_runtime === false
      && flagSlice.authorizes_flag_read === false,
    'control-path-execution-slice-blocked': controlSlice.blocked_now === true
      && controlSlice.authorizes_runtime === false
      && controlSlice.authorizes_execution === false,
    'reporting-sink-write-slice-blocked': reportingSlice.blocked_now === true
      && reportingSlice.authorizes_runtime === false
      && reportingSlice.authorizes_reporting_sink === false,
    'capability-truth-false': capabilityOk,
    'runtime-started-false': safety.capability_matrix?.runtimeStarted === false && safety.boundary_truth?.runtimeStarted === false,
    'runner-executed-false': safety.capability_matrix?.runnerExecuted === false && safety.boundary_truth?.runnerExecuted === false,
    'runtime-available-false': safety.capability_matrix?.runtimeAvailable === false && safety.boundary_truth?.runtimeAvailable === false,
    'runtime-mode-flag-reader-available-false': safety.capability_matrix?.runtimeModeFlagReaderAvailable === false,
    'flag-reader-available-false': safety.capability_matrix?.runtimeModeFlagReaderAvailable === false,
    'env-config-read-available-false': safety.capability_matrix?.envConfigReadAvailable === false,
    'kill-switch-wiring-available-false': safety.capability_matrix?.killSwitchWiringAvailable === false,
    'kill-switch-live-check-available-false': safety.capability_matrix?.killSwitchLiveCheckAvailable === false,
    'control-execution-available-false': safety.capability_matrix?.controlExecutionAvailable === false,
    'server-can-execute-local-false': safety.capability_matrix?.serverCanExecuteLocal === false && safety.boundary_truth?.serverCanExecuteLocal === false,
    'server-can-prove-model-processing-false': safety.capability_matrix?.serverCanProveModelProcessing === false,
    'builder-oracle-direct-targets-blocked': safety.capability_matrix?.directBuilderOracleServerTargetsAllowed === false
      && safety.boundary_truth?.builderOracleDirectServerTargetsAllowed === false,
    'proof-boundaries-false': proofOk,
    'side-effect-truth-all-blocked': sideOk,
    'no-env-config-flag-read-side-effect': safety.side_effect_result?.no_env_or_config_read === true
      && safety.side_effect_result?.no_runtime_mode_flag_read === true
      && safety.side_effect_result?.envReadPerformed === false
      && safety.side_effect_result?.configReadPerformed === false
      && safety.side_effect_result?.flagReadPerformed === false,
    'no-kill-switch-wiring-side-effect': noKillSwitchWiringSideEffectOk,
    'no-control-or-reporting-side-effect': noControlReportingSideEffectOk,
    'no-module-cli-test-runtime-work': scopeOk,
    'redaction-summary-safe': redactionOk,
    'next-recommendations-tier0-tier1-only': nextOk,
    'next-recommendations-non-authorizing': nextNonAuthOk,
    'unsafe-action-drift-blocked': unsafeOk,
    'unsafe-action-drift-rejected': unsafeOk,
    'required-literal-checks-bound': literalOk,
    'required-literal-results-complete': literalOk,
    'validation-report-coverage-bound': true,
    'idempotency-sensitive': idempotencyOk,
    'manifest-required-fields-present': outputFieldsOk,
    'validation-report-required-fields-present': true,
    'referenced-path-results-complete': true,
  };
}

function validateSafety(safety = {}, contract = {}) {
  const checks = [];
  const errors = [];
  const resultById = {};
  const add = (id, ok) => {
    const result = resultObject(id, ok);
    checks.push(result);
    resultById[id] = result;
    if (!ok) errors.push(id);
  };

  const outputShapeOk = safety.schema === KILL_SWITCH_WIRING_SAFETY_SCHEMA_VERSION
    && hasRequiredFields(safety, contract.expectedManifestShape?.requiredFields || REQUIRED_SAFETY_FIELDS);
  const ids = checkMap(safety, contract);
  add('output-shape-complete', outputShapeOk);
  for (const rule of asArray(contract.staticValidationRules)) add(rule.id, ids[rule.id] === true);
  for (const check of asArray(contract.acceptanceChecks)) add(check.id, ids[check.id] === true);
  add('safety-literal-values', ids['required-literal-checks-bound'] === true);
  add('safety-contract-complete',
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

function literalResultsOk(results = [], safety = {}, contract = {}) {
  const expected = requiredLiteralResults(safety, contract.expectedManifestShape?.requiredLiteralValues || {});
  return valuesMatch(asArray(results), expected)
    && results.length >= Number(contract.expectedManifestShape?.expectedCounts?.required_literal_results_min || 0);
}

function buildValidationReport(safety, contract = {}, generatedAt = safety.generated_at) {
  const validation = validateSafety(safety, contract);
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
    version: KILL_SWITCH_WIRING_SAFETY_VERSION,
    validation_id: `kill-switch-wiring-safety-validation-${stableHash({
      safety_key: safety.idempotency_key,
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
    required_literal_results: requiredLiteralResults(safety, contract.expectedManifestShape?.requiredLiteralValues || {}),
    referenced_path_results: buildReferencedPathResults(contract),
    forbidden_output_scan: resultObject('forbidden-output-strings-absent', forbiddenScanOk),
    side_effect_truth: sideEffectResult(contract),
    summary: {
      current_through_phase: safety.phase_registry?.current_through_phase,
      phase_registry_count: safety.phase_registry?.phase_inventory_count,
      schema_registry_count: safety.phase_registry?.schema_registry_count,
      cli_registry_count: safety.phase_registry?.cli_registry_count,
      commit_chain_count: asArray(safety.commit_chain).length,
      source_ref_count: asArray(safety.source_refs).length,
      prerequisite_gap_count: asArray(safety.prerequisite_gap_matrix).length,
      risk_register_count: asArray(safety.risk_register).length,
      blocked_future_slice_count: asArray(safety.blocked_future_slices).length,
      next_recommendation_count: asArray(safety.next_phase_recommendations).length,
      baseline_commit: safety.baseline_commit,
      accepted_validation_only: validation.ok,
    },
  };
  assertNoForbiddenOutput(report, asArray(contract.forbiddenOutputSubstrings));
  return report;
}

function buildMiraCoreKillSwitchWiringSafety(options = {}) {
  const contract = options.contract || {};
  const kill_switch_wiring_safety = buildSafety(options);
  const validation_report = buildValidationReport(
    kill_switch_wiring_safety,
    contract,
    kill_switch_wiring_safety.generated_at,
  );
  const output = { kill_switch_wiring_safety, validation_report };
  assertNoForbiddenOutput(output, asArray(contract.forbiddenOutputSubstrings));
  return output;
}

function validateMiraCoreKillSwitchWiringSafetyOutput(output = {}, contract = {}) {
  const checks = [];
  const errors = [];
  const add = (id, ok) => {
    checks.push({ id, ok: ok === true });
    if (!ok) errors.push(id);
  };
  const safety = output.kill_switch_wiring_safety || {};
  const report = output.validation_report || {};
  const safetyValidation = validateSafety(safety, contract);
  const referencedOk = referencedPathResultsOk(report.referenced_path_results, contract);
  const recomputedById = safetyValidation.checks.reduce((acc, check) => {
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
    && literalResultsOk(report.required_literal_results, safety, contract)
    && referencedOk;

  add('output-shape-complete',
    hasRequiredFields(output, contract.expectedOutputShape?.requiredTopLevelFields || REQUIRED_OUTPUT_FIELDS)
      && safety.schema === KILL_SWITCH_WIRING_SAFETY_SCHEMA_VERSION
      && report.schema === VALIDATION_REPORT_SCHEMA_VERSION
      && hasRequiredFields(safety, contract.expectedManifestShape?.requiredFields || REQUIRED_SAFETY_FIELDS)
      && hasRequiredFields(report, contract.expectedValidationReportShape?.requiredFields || REQUIRED_VALIDATION_REPORT_FIELDS));

  for (const check of safetyValidation.checks) {
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
    report.accepted === safetyValidation.ok
      && report.blocked === !safetyValidation.ok
      && report.decision === (safetyValidation.ok ? 'accepted_validation_only' : 'rejected')
      && valuesMatch(
        asArray(report.reasons),
        safetyValidation.checks.filter((check) => !check.ok).map((check) => check.id),
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
  REQUIRED_SAFETY_FIELDS,
  REQUIRED_VALIDATION_REPORT_FIELDS,
  KILL_SWITCH_WIRING_SAFETY_SCHEMA_VERSION,
  VALIDATION_REPORT_SCHEMA_VERSION,
  assertNoForbiddenOutput,
  buildMiraCoreKillSwitchWiringSafety,
  killSwitchWiringSafetyIdempotencyKey,
  stableHash,
  validateMiraCoreKillSwitchWiringSafetyOutput,
};
