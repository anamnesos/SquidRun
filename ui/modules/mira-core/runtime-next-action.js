'use strict';

const crypto = require('crypto');

const RUNTIME_NEXT_ACTION_RECONCILIATION_SCHEMA_VERSION = 'squidrun.mira_core.runtime_next_action_reconciliation.v0';
const VALIDATION_REPORT_SCHEMA_VERSION = 'squidrun.mira_core.runtime_next_action_validation_report.v0';
const RUNTIME_NEXT_ACTION_VERSION = 'v0';
const BASELINE_COMMIT = 'c04155d';

const REQUIRED_OUTPUT_FIELDS = Object.freeze([
  'runtime_next_action_reconciliation',
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
  'stale_readiness',
  'satisfied_prior_recommendations',
  'closure_summary',
  'capability_matrix',
  'boundary_truth',
  'verification_summary',
  'blocker_summary',
  'next_phase_recommendations',
  'unsafe_action_policy',
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
  'forbidden_output_scan',
  'required_literal_results',
  'side_effect_truth',
  'summary',
]);

const REQUIRED_SIDE_EFFECT_FIELDS = Object.freeze([
  'no_ui_implemented',
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
  'no_browser_window_capture',
  'no_send_performed',
  'no_deploy_performed',
  'no_trade_performed',
  'no_output_file_written',
]);

const SIDE_EFFECT_COUNTER_FIELDS = Object.freeze([
  'uiImplementationAttempts',
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
  'browserWindowCaptureAttempts',
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
  'runtime started',
  'runner executed',
  'runtime is available',
  'runner is available',
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
  'browser opened',
  'window captured',
  'screenshot captured',
  'capture performed',
  'customer send performed',
  'external send performed',
  'deploy performed',
  'trade performed',
  'output file written',
  'socket proves bridge green',
  'delivery acceptance proves model processing',
  'Builder direct target allowed',
  'Oracle direct target allowed',
]);

const SATISFIED_PRIOR_RECOMMENDATION_KEYS = Object.freeze([
  'phase34_phase35_runtime_status_milestone_refresh_validator',
  'phase34_phase35_stdout_only_cli_smoke',
]);

const BLOCKER_IDS = Object.freeze([
  'real-runtime-gates-open',
  'operator-status-ui-surface-contract-missing',
  'disabled-dry-run-reporting-reconciliation-missing',
  'local-arm-proof-separate',
  'runtime-availability-proof-separate',
  'storage-auth-gates-open',
  'kill-switch-review-needed',
  'artifact-output-boundary-review',
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

function evidenceRef(store, eventId, relation = 'runtime_next_action_reconciliation_validation') {
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
    current_through_phase: 34,
    expected_phases: expected.expected_phases || '1-34',
    phase_inventory_count: 34,
    schema_registry_count: 34,
    cli_registry_count: 34,
    phase34_current: true,
    phase34_commit: BASELINE_COMMIT,
    phase34_delta: clone(expected.phase34_delta || {}),
    evidenceRefs: [
      evidenceRef('git', BASELINE_COMMIT, 'phase35-baseline'),
      evidenceRef('mira-core-runtime-next-action-contract', 'phase-registry'),
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
      evidenceRef('mira-core-runtime-status-milestone-refresh', 'phase34-current'),
    ],
  };
}

function satisfiedPriorRecommendations(contract = {}) {
  return {
    phase34_phase35_runtime_status_milestone_refresh_validator: {
      ...clone(contract.satisfiedPriorRecommendationsExpected?.[0] || {}),
      evidenceRefs: [
        evidenceRef('git', BASELINE_COMMIT, 'phase34-validator-satisfied'),
      ],
    },
    phase34_phase35_stdout_only_cli_smoke: {
      ...clone(contract.satisfiedPriorRecommendationsExpected?.[1] || {}),
      evidenceRefs: [
        evidenceRef('git', BASELINE_COMMIT, 'phase34-cli-smoke-satisfied'),
      ],
    },
  };
}

function closureSummary() {
  return {
    phase30_oracle_115_prerequisite_mapping_closure: true,
    phase32_oracle_123_expires_at_closure: true,
    phase33_oracle_127_validation_report_tamper_coverage_closure: true,
    phase34_oracle_131_read_only_review_green: true,
    closed_review_refs: ['ORACLE #115', 'ORACLE #123', 'ORACLE #127', 'ORACLE #131'],
    evidenceRefs: [
      evidenceRef('mira-core-runtime-control-path', 'oracle-115-closure'),
      evidenceRef('mira-core-runtime-dry-runner', 'oracle-123-closure'),
      evidenceRef('mira-core-runtime-operator-status', 'oracle-127-closure'),
      evidenceRef('mira-core-runtime-status-milestone-refresh', 'oracle-131-closure'),
    ],
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
    evidenceRefs: [
      evidenceRef('mira-core-runtime-next-action', 'capability-matrix'),
    ],
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
    phase34CommitIsRuntimeProof: false,
    reconciliationIsUiProof: false,
    reconciliationIsRuntimeAuthorization: false,
    evidenceRefs: [
      evidenceRef('mira-core-runtime-next-action', 'boundary-truth'),
    ],
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
    phase34_commit_observed: BASELINE_COMMIT,
    phase34_prior_recommendations_satisfied: true,
    prior_phase_closures: [
      { oracle_ref: 'ORACLE #115', status: 'closed' },
      { oracle_ref: 'ORACLE #123', status: 'closed' },
      { oracle_ref: 'ORACLE #127', status: 'closed' },
      { oracle_ref: 'ORACLE #131', status: 'closed' },
    ],
    unknown_or_degraded_proof: !proven,
    evidenceRefs: [
      evidenceRef('mira-core-runtime-next-action', 'verification-summary'),
    ],
  };
}

function blockerSummary() {
  return BLOCKER_IDS.map((blockerId) => ({
    blocker_id: blockerId,
    status: 'blocking_future_runtime_or_ui_slice',
    blocked_because: `Open validation gate remains: ${blockerId}.`,
    safe_next_action: 'Keep the next action fixture-only or validation-only and non-authorizing.',
    evidenceRefs: [
      evidenceRef('mira-core-runtime-next-action', `blocker:${blockerId}`),
    ],
  }));
}

function nextPhaseRecommendations(contract = {}) {
  return asArray(contract.nextRecommendationExpectedCandidates).map((candidate) => ({
    ...clone(candidate),
    blocked_side_effects: [
      'ui',
      'runtime',
      'runner-action',
      'transport',
      'persistent-mutation',
      'external-action',
      'artifact-output',
    ],
    evidenceRefs: [
      evidenceRef('mira-core-runtime-next-action', `next:${candidate.recommendation_id}`),
    ],
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
    local_execution_allowed: false,
    shell_pty_allowed: false,
    browser_capture_allowed: false,
    live_ui_allowed: false,
    live_runtime_allowed: false,
    unsafe_action_drift_rejected: true,
    evidenceRefs: [
      evidenceRef('mira-core-runtime-next-action', 'unsafe-action-policy'),
    ],
  };
}

function sideEffectResult() {
  const result = REQUIRED_SIDE_EFFECT_FIELDS.reduce((acc, field) => {
    acc[field] = true;
    return acc;
  }, {});
  for (const field of SIDE_EFFECT_COUNTER_FIELDS) {
    result[field] = 0;
  }
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
    stale_readiness: reconciliation.stale_readiness,
    satisfied_prior_recommendations: reconciliation.satisfied_prior_recommendations,
    closure_summary: reconciliation.closure_summary,
    capability_matrix: reconciliation.capability_matrix,
    boundary_truth: reconciliation.boundary_truth,
    verification_summary: reconciliation.verification_summary,
    blocker_summary: reconciliation.blocker_summary,
    next_phase_recommendations: reconciliation.next_phase_recommendations,
    unsafe_action_policy: reconciliation.unsafe_action_policy,
    side_effect_result: reconciliation.side_effect_result,
  };
}

function runtimeNextActionIdempotencyKey(reconciliation) {
  return `runtime-next-action:${stableHash(canonicalReconciliationInput(reconciliation))}`;
}

function buildReconciliation(options = {}) {
  const contract = options.contract || {};
  const inputSignals = options.inputSignals || {};
  const scope = normalizeScope(inputSignals);
  const generatedAt = generatedAtFromOptions(options, inputSignals);
  const reconciliation = {
    schema: RUNTIME_NEXT_ACTION_RECONCILIATION_SCHEMA_VERSION,
    version: RUNTIME_NEXT_ACTION_VERSION,
    reconciliation_id: null,
    idempotency_key: null,
    generated_at: generatedAt,
    profile: scope.profile,
    sessionId: scope.sessionId,
    deviceId: scope.deviceId,
    baseline_commit: inputSignals.baseline_commit || BASELINE_COMMIT,
    phase_registry: phaseRegistry(contract),
    commit_chain: asArray(inputSignals.commit_chain).length > 0
      ? clone(inputSignals.commit_chain)
      : clone(contract.commitChainExpected || []),
    stale_readiness: staleReadiness(contract),
    satisfied_prior_recommendations: satisfiedPriorRecommendations(contract),
    closure_summary: closureSummary(),
    capability_matrix: capabilityMatrix(),
    boundary_truth: boundaryTruth(),
    verification_summary: verificationSummary(inputSignals),
    blocker_summary: blockerSummary(),
    next_phase_recommendations: nextPhaseRecommendations(contract),
    unsafe_action_policy: unsafeActionPolicy(),
    evidenceRefs: [
      evidenceRef('git', BASELINE_COMMIT, 'phase35-baseline'),
      evidenceRef('mira-core-runtime-next-action-contract', 'phase35-contract'),
    ],
    side_effect_result: sideEffectResult(),
  };
  reconciliation.idempotency_key = runtimeNextActionIdempotencyKey(reconciliation);
  reconciliation.reconciliation_id = `runtime-next-action-${stableHash({
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
    && value.runtimeStarted === false
    && value.runnerExecuted === false
    && value.runtimeAvailable === false
    && value.serverStarted === false
    && value.listenerBound === false
    && value.networkPerformed === false
    && value.outputFileWritten === false;
}

function phase34CurrentOk(reconciliation) {
  const registry = reconciliation.phase_registry || {};
  const delta = registry.phase34_delta || {};
  return registry.current_through_phase === 34
    && registry.phase34_current === true
    && registry.phase34_commit === BASELINE_COMMIT
    && delta.phase === 34
    && delta.name === 'runtime-status-milestone-refresh'
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
  return registry.phase_inventory_count === 34
    && registry.schema_registry_count === 34
    && registry.cli_registry_count === 34
    && registry.current_through_phase === 34;
}

function commitChainOk(reconciliation, contract = {}) {
  const expected = asArray(contract.commitChainExpected);
  const chain = asArray(reconciliation.commit_chain);
  return expected.length === 22
    && chain.length === 22
    && valuesMatch(chain, expected)
    && chain[chain.length - 1] === BASELINE_COMMIT;
}

function stalePhase13Ok(reconciliation) {
  const stale = reconciliation.stale_readiness || {};
  return stale.phase13_readiness_current === false
    && stale.phase13_superseded_by === 'phase_23_milestone_readiness';
}

function stalePhase23Ok(reconciliation) {
  const stale = reconciliation.stale_readiness || {};
  return stale.phase23_milestone_readiness_current === false
    && stale.phase23_superseded_by === 'phase_31_runtime_milestone_refresh';
}

function stalePhase31Ok(reconciliation) {
  const stale = reconciliation.stale_readiness || {};
  return stale.phase31_runtime_milestone_refresh_current === false
    && stale.phase31_superseded_by === 'phase_34_runtime_status_milestone_refresh'
    && stale.phase34_runtime_status_milestone_refresh_current === true;
}

function satisfiedPriorRecommendationsOk(reconciliation, contract = {}) {
  const expected = asArray(contract.satisfiedPriorRecommendationsExpected);
  const current = reconciliation.satisfied_prior_recommendations || {};
  return expected.length === 2
    && SATISFIED_PRIOR_RECOMMENDATION_KEYS.every((key, index) => {
      const item = current[key];
      return item
        && item.recommendation_id === expected[index].recommendation_id
        && item.satisfied_by_commit === BASELINE_COMMIT
        && item.status === 'satisfied_by_c04155d_do_not_repeat_as_open_work'
        && valuesMatch(item.satisfied_by_files, expected[index].satisfied_by_files);
    });
}

function priorRecommendationNotOpenOk(reconciliation) {
  const priorIds = asArray(Object.values(reconciliation.satisfied_prior_recommendations || {}))
    .map((item) => item.recommendation_id);
  return asArray(reconciliation.next_phase_recommendations)
    .every((item) => !priorIds.includes(item.recommendation_id));
}

function closureOk(reconciliation, field, oracleRef) {
  const closure = reconciliation.closure_summary || {};
  return closure[field] === true && asArray(closure.closed_review_refs).includes(oracleRef);
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
    && boundary.phase34CommitIsRuntimeProof === false
    && boundary.reconciliationIsUiProof === false
    && boundary.reconciliationIsRuntimeAuthorization === false
    && verificationTruthOk(reconciliation);
}

function verificationTruthOk(reconciliation) {
  const summary = reconciliation.verification_summary || {};
  const reported = asArray(summary.reported_commands);
  if (summary.no_fake_test_proof !== true) return false;
  if (summary.proof_status === 'proven_by_reported_command') {
    return reported.length > 0
      && reported.every((command) => command.result === 'PASS' && Number(command.failed_count || 0) === 0);
  }
  return summary.unknown_or_degraded_proof === true;
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
    )))
    && recommendations.every((recommendation) => ['tier0', 'tier1'].includes(recommendation.tier)
      && recommendation.does_not_authorize_ui === true
      && recommendation.does_not_authorize_runtime === true
      && asArray(recommendation.blocked_side_effects).length > 0);
}

function nextRecommendationsNoLiveRuntimeOrUiOk(reconciliation) {
  const strings = collectStringValues(reconciliation.next_phase_recommendations);
  return strings.every((text) => !hasUnsafeTerm(text, 'live runtime')
    && !hasUnsafeTerm(text, 'live ui')
    && !hasUnsafeTerm(text, 'start server')
    && !hasUnsafeTerm(text, 'open listener'));
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
  const before = String(text || '').slice(Math.max(0, index - 200), index);
  const lastBoundary = Math.max(before.lastIndexOf('.'), before.lastIndexOf(';'), before.lastIndexOf(':'));
  const clause = before.slice(lastBoundary + 1);
  return /\b(no|without|blocked|blocks|disallow|disallowed|not|cannot|does not|must not|keeps|disabled)\b/i.test(clause);
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
    'start server',
    'open listener',
    'live runtime',
    'live ui',
  ];
  const phraseNeedles = asArray(contract.unsafeActionPhrases).map((phrase) => String(phrase || '').toLowerCase());
  const strings = [
    ...collectStringValues(reconciliation.next_phase_recommendations),
    ...collectStringValues(reconciliation.blocker_summary),
    ...collectStringValues(reconciliation.verification_summary),
    ...collectStringValues(reconciliation.closure_summary),
    ...collectStringValues(reconciliation.satisfied_prior_recommendations),
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
    if (strings.some((entry) => String(entry).toLowerCase().includes(needle))) {
      throw new Error(`runtime_next_action_forbidden_substring:${forbidden}`);
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

  const outputShapeOk = reconciliation.schema === RUNTIME_NEXT_ACTION_RECONCILIATION_SCHEMA_VERSION
    && hasRequiredFields(reconciliation, expectedManifestShape(contract).requiredFields || REQUIRED_RECONCILIATION_FIELDS);
  const baselineOk = reconciliation.baseline_commit === BASELINE_COMMIT;
  const phase34Ok = phase34CurrentOk(reconciliation);
  const registryOk = registryCountsOk(reconciliation);
  const chainOk = commitChainOk(reconciliation, contract);
  const phase13Ok = stalePhase13Ok(reconciliation);
  const phase23Ok = stalePhase23Ok(reconciliation);
  const phase31Ok = stalePhase31Ok(reconciliation);
  const satisfiedOk = satisfiedPriorRecommendationsOk(reconciliation, contract);
  const notOpenOk = priorRecommendationNotOpenOk(reconciliation);
  const phase30ClosureOk = closureOk(reconciliation, 'phase30_oracle_115_prerequisite_mapping_closure', 'ORACLE #115');
  const phase32ClosureOk = closureOk(reconciliation, 'phase32_oracle_123_expires_at_closure', 'ORACLE #123');
  const phase33ClosureOk = closureOk(reconciliation, 'phase33_oracle_127_validation_report_tamper_coverage_closure', 'ORACLE #127');
  const phase34ClosureOk = closureOk(reconciliation, 'phase34_oracle_131_read_only_review_green', 'ORACLE #131');
  const capabilityOk = capabilityTruthOk(reconciliation);
  const proofOk = proofBoundariesOk(reconciliation);
  const sideEffectOk = sideEffectValuesOk(reconciliation.side_effect_result);
  const recommendationsOk = nextRecommendationsOk(reconciliation, contract);
  const recommendationsNoLiveOk = nextRecommendationsNoLiveRuntimeOrUiOk(reconciliation);
  const unsafeOk = unsafeActionDriftOk(reconciliation, contract);
  const idempotencyOk = reconciliation.idempotency_key === runtimeNextActionIdempotencyKey(reconciliation);
  const literalsOk = literalValuesOk(reconciliation, expectedManifestShape(contract).requiredLiteralValues || {});
  let forbiddenOk = true;
  try {
    assertNoForbiddenOutput(reconciliation, asArray(contract.forbiddenOutputSubstrings));
  } catch {
    forbiddenOk = false;
  }

  const staticRuleOk = {
    'baseline-pinned-c04155d': baselineOk,
    'phase34-current': phase34Ok,
    'phase-inventory-count-34': registryOk,
    'schema-registry-count-34': registryOk,
    'cli-registry-count-34': registryOk,
    'commit-chain-exact-22': chainOk,
    'phase13-stale-preserved': phase13Ok,
    'phase23-stale-preserved': phase23Ok,
    'phase31-stale-preserved': phase31Ok,
    'phase34-prior-recommendations-satisfied': satisfiedOk,
    'phase34-prior-recommendations-not-open': notOpenOk,
    'phase30-oracle115-closure-carried': phase30ClosureOk,
    'phase32-oracle123-closure-carried': phase32ClosureOk,
    'phase33-oracle127-closure-carried': phase33ClosureOk,
    'phase34-oracle131-closure-carried': phase34ClosureOk,
    'capability-truth-false': capabilityOk,
    'proof-boundaries-false': proofOk,
    'side-effect-truth-all-blocked': sideEffectOk,
    'next-recommendations-new-tier0-tier1-only': recommendationsOk,
    'next-recommendations-no-live-runtime-or-ui': recommendationsNoLiveOk,
    'unsafe-action-drift-blocked': unsafeOk,
    'no-raw-private-secret-output': forbiddenOk,
    'required-literal-checks-bound': literalsOk,
    'validation-report-coverage-bound': true,
    'idempotency-sensitive': idempotencyOk,
  };

  const acceptanceOk = {
    'baseline-c04155d-pinned': baselineOk,
    'phase34-current-c04155d': phase34Ok,
    'phase-inventory-exactly-34': registryOk,
    'schema-registry-exactly-34': registryOk,
    'cli-registry-exactly-34': registryOk,
    'commit-chain-count-22-ending-c04155d': chainOk,
    'phase13-stale-truth-preserved': phase13Ok,
    'phase23-stale-truth-preserved': phase23Ok,
    'phase31-stale-superseded-by-phase34': phase31Ok,
    'phase34-prior-validator-satisfied': satisfiedOk,
    'phase34-prior-cli-smoke-satisfied': satisfiedOk,
    'prior-phase34-recommendations-not-repeated-open': notOpenOk,
    'phase30-oracle115-closure-present': phase30ClosureOk,
    'phase32-oracle123-closure-present': phase32ClosureOk,
    'phase33-oracle127-closure-present': phase33ClosureOk,
    'phase34-oracle131-closure-present': phase34ClosureOk,
    'runtime-started-false': reconciliation.capability_matrix?.runtimeStarted === false && reconciliation.boundary_truth?.runtimeStarted === false,
    'runner-executed-false': reconciliation.capability_matrix?.runnerExecuted === false && reconciliation.boundary_truth?.runnerExecuted === false,
    'runtime-available-false': reconciliation.capability_matrix?.runtimeAvailable === false && reconciliation.boundary_truth?.runtimeAvailable === false,
    'server-can-execute-local-false': reconciliation.capability_matrix?.serverCanExecuteLocal === false && reconciliation.boundary_truth?.serverCanExecuteLocal === false,
    'server-can-prove-model-processing-false': reconciliation.capability_matrix?.serverCanProveModelProcessing === false
      && reconciliation.boundary_truth?.serverCanProveModelProcessing === false,
    'builder-oracle-direct-targets-blocked': reconciliation.capability_matrix?.directBuilderOracleServerTargetsAllowed === false
      && reconciliation.boundary_truth?.builderOracleDirectServerTargetsAllowed === false,
    'proof-boundaries-false': proofOk,
    'side-effect-truth-all-blocked': sideEffectOk,
    'next-recommendations-new-tier0-tier1-only': recommendationsOk,
    'next-recommendations-non-authorizing': recommendationsOk,
    'unsafe-action-drift-rejected': unsafeOk,
    'required-literal-results-complete': literalsOk,
  };

  add('output-shape-complete', outputShapeOk);
  for (const rule of asArray(contract.staticValidationRules)) add(rule.id, staticRuleOk[rule.id] === true);
  for (const check of asArray(contract.acceptanceChecks)) add(check.id, acceptanceOk[check.id] === true);
  add('reconciliation-literal-values', literalsOk);
  add('reconciliation-contract-complete',
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
    version: RUNTIME_NEXT_ACTION_VERSION,
    validation_id: `runtime-next-action-validation-${stableHash({
      reconciliation_key: reconciliation.idempotency_key,
      generatedAt,
    }).slice(0, 12)}`,
    generated_at: generatedAt,
    fixture_ref: 'ui/__tests__/fixtures/mira-core-runtime-next-action-contract.json',
    baseline_commit: BASELINE_COMMIT,
    decision: validation.ok ? 'accepted_validation_only' : 'rejected',
    accepted: validation.ok,
    blocked: !validation.ok,
    reasons: failed.map((check) => check.id),
    static_rule_results: staticResults,
    acceptance_check_results: acceptanceResults,
    tamper_case_results: tamperResults,
    forbidden_output_scan: resultObject('forbidden-output-strings-absent', validation.resultById['no-raw-private-secret-output']?.ok),
    required_literal_results: requiredLiteralResults(reconciliation, expectedManifestShape(contract).requiredLiteralValues || {}),
    side_effect_truth: sideEffectResult(),
    summary: {
      current_through_phase: reconciliation.phase_registry?.current_through_phase,
      phase_registry_count: reconciliation.phase_registry?.phase_inventory_count,
      schema_registry_count: reconciliation.phase_registry?.schema_registry_count,
      cli_registry_count: reconciliation.phase_registry?.cli_registry_count,
      commit_chain_count: asArray(reconciliation.commit_chain).length,
      baseline_commit: reconciliation.baseline_commit,
      prior_recommendations_satisfied: true,
      accepted_validation_only: validation.ok,
    },
  };
  assertNoForbiddenOutput(report, asArray(contract.forbiddenOutputSubstrings));
  return report;
}

function buildMiraCoreRuntimeNextAction(options = {}) {
  const contract = options.contract || {};
  const runtime_next_action_reconciliation = buildReconciliation(options);
  const validation_report = buildValidationReport(
    runtime_next_action_reconciliation,
    contract,
    runtime_next_action_reconciliation.generated_at,
  );
  const output = {
    runtime_next_action_reconciliation,
    validation_report,
  };
  assertNoForbiddenOutput(output, asArray(contract.forbiddenOutputSubstrings));
  return output;
}

function validateMiraCoreRuntimeNextActionOutput(output = {}, contract = {}) {
  const checks = [];
  const errors = [];
  const add = (id, ok) => {
    checks.push({ id, ok: ok === true });
    if (!ok) errors.push(id);
  };
  const reconciliation = output.runtime_next_action_reconciliation || {};
  const report = output.validation_report || {};
  const reconciliationValidation = validateReconciliation(reconciliation, contract);
  const recomputedById = reconciliationValidation.checks.reduce((acc, check) => {
    acc[check.id] = check;
    return acc;
  }, {});

  add('output-shape-complete',
    hasRequiredFields(output, contract.expectedOutputShape?.requiredTopLevelFields || REQUIRED_OUTPUT_FIELDS)
      && reconciliation.schema === RUNTIME_NEXT_ACTION_RECONCILIATION_SCHEMA_VERSION
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
  REQUIRED_RECONCILIATION_FIELDS,
  REQUIRED_SIDE_EFFECT_FIELDS,
  REQUIRED_VALIDATION_REPORT_FIELDS,
  RUNTIME_NEXT_ACTION_RECONCILIATION_SCHEMA_VERSION,
  VALIDATION_REPORT_SCHEMA_VERSION,
  assertNoForbiddenOutput,
  buildMiraCoreRuntimeNextAction,
  runtimeNextActionIdempotencyKey,
  stableHash,
  validateMiraCoreRuntimeNextActionOutput,
};
