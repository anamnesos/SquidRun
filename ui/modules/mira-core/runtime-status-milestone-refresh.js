'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const RUNTIME_STATUS_MILESTONE_REFRESH_MANIFEST_SCHEMA_VERSION = 'squidrun.mira_core.runtime_status_milestone_refresh_manifest.v0';
const VALIDATION_REPORT_SCHEMA_VERSION = 'squidrun.mira_core.runtime_status_milestone_refresh_validation_report.v0';
const RUNTIME_STATUS_MILESTONE_REFRESH_VERSION = 'v0';
const BASELINE_COMMIT = '0e82768';

const REQUIRED_OUTPUT_FIELDS = Object.freeze([
  'runtime_status_milestone_refresh_manifest',
  'validation_report',
]);

const REQUIRED_MANIFEST_FIELDS = Object.freeze([
  'schema',
  'version',
  'manifest_id',
  'idempotency_key',
  'generated_at',
  'profile',
  'sessionId',
  'deviceId',
  'baseline_commit',
  'phase_inventory',
  'schema_registry',
  'cli_registry',
  'commit_chain',
  'stale_readiness',
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
  'referenced_path_results',
  'forbidden_output_scan',
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

const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');

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

function evidenceRef(store, eventId, relation = 'runtime_status_milestone_refresh_validation') {
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

function phaseCapabilityTruth(contract = {}) {
  return {
    ...(expectedManifestShape(contract).phaseCapabilityTruthRequiredValues || {}),
    localArmsProofSeparate: true,
  };
}

function phaseInventory(contract = {}) {
  return asArray(contract.phaseRegistryExpected).map((item) => ({
    ...clone(item),
    capability_truth: phaseCapabilityTruth(contract),
    evidenceRefs: [
      evidenceRef('mira-core-phase-registry', `phase:${item.phase}`),
      evidenceRef('git', item.committed_baseline, `phase:${item.phase}:baseline`),
    ],
  }));
}

function schemaRegistry(contract = {}) {
  return asArray(contract.phaseRegistryExpected).map((item) => ({
    phase: item.phase,
    name: item.name,
    fixture_path: item.fixture_path,
    module_path: item.module_path,
    test_path: item.test_path,
    schema_status: 'registered_validation_reference',
    evidenceRefs: [
      evidenceRef('mira-core-schema-registry', `phase:${item.phase}`),
    ],
  }));
}

function cliRegistry(contract = {}) {
  return asArray(contract.phaseRegistryExpected).map((item) => ({
    phase: item.phase,
    name: item.name,
    cli_path: item.cli_path,
    stdout_only_required: true,
    output_behavior: 'stdout_only',
    side_effects_allowed: false,
    evidenceRefs: [
      evidenceRef('mira-core-cli-registry', `phase:${item.phase}`),
    ],
  }));
}

function staleReadiness() {
  return {
    phase13_readiness_current: false,
    phase13_superseded_by: 'phase_23_milestone_readiness',
    phase23_milestone_readiness_current: false,
    phase23_superseded_by: 'phase_31_runtime_milestone_refresh',
    phase31_runtime_milestone_refresh_current: false,
    phase31_superseded_by: 'phase_34_runtime_status_milestone_refresh',
    evidenceRefs: [
      evidenceRef('mira-core-readiness', 'phase13-stale'),
      evidenceRef('mira-core-milestone-readiness', 'phase23-stale'),
      evidenceRef('mira-core-runtime-milestone-refresh', 'phase31-stale'),
    ],
  };
}

function closureSummary() {
  return {
    phase30_oracle_115_prerequisite_mapping_closure: true,
    phase30_recomputed_idempotency_bogus_mapping_rejected: true,
    phase32_oracle_123_expires_at_closure: true,
    phase32_expires_at_bound_to_generated_at: true,
    phase33_oracle_127_validation_report_tamper_coverage_closure: true,
    phase33_static_acceptance_ok_values_recomputed: true,
    phase33_tamper_results_bound_to_fixture: true,
    closed_review_refs: ['ORACLE #115', 'ORACLE #123', 'ORACLE #127'],
    evidenceRefs: [
      evidenceRef('mira-core-runtime-control-path', 'oracle-115-closure'),
      evidenceRef('mira-core-runtime-dry-runner', 'oracle-123-closure'),
      evidenceRef('mira-core-runtime-operator-status', 'oracle-127-closure'),
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
      evidenceRef('mira-core-runtime-status-milestone-refresh', 'capability-matrix'),
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
    statusSurfaceIsRuntimeProof: false,
    dryRunnerContractIsRunnerExecutionProof: false,
    localArmProofSeparate: true,
    evidenceRefs: [
      evidenceRef('mira-core-runtime-status-milestone-refresh', 'boundary-truth'),
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
    prior_phase_closures: [
      { oracle_ref: 'ORACLE #115', status: 'closed' },
      { oracle_ref: 'ORACLE #123', status: 'closed' },
      { oracle_ref: 'ORACLE #127', status: 'closed' },
    ],
    unknown_or_degraded_proof: !proven,
    evidenceRefs: [
      evidenceRef('mira-core-runtime-status-milestone-refresh', 'verification-summary'),
    ],
  };
}

function blockerSummary() {
  return [
    'real-runtime-gates-open',
    'operator-status-ui-not-built',
    'local-arm-proof-separate',
    'storage-auth-gates-open',
    'kill-switch-review-needed',
    'telemetry-redaction-review',
    'replay-watermark-review',
    'artifact-output-boundary-review',
  ].map((blockerId) => ({
    blocker_id: blockerId,
    status: 'blocking_future_runtime_slice',
    blocked_because: `Open validation gate remains: ${blockerId}.`,
    safe_next_action: 'Review a contract-only follow-up and keep the action path disabled.',
    evidenceRefs: [
      evidenceRef('mira-core-runtime-status-milestone-refresh', `blocker:${blockerId}`),
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
      evidenceRef('mira-core-runtime-status-milestone-refresh', `next:${candidate.recommendation_id}`),
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
    unsafe_action_drift_rejected: true,
    evidenceRefs: [
      evidenceRef('mira-core-runtime-status-milestone-refresh', 'unsafe-action-policy'),
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

function canonicalManifestInput(manifest = {}) {
  return {
    profile: manifest.profile,
    sessionId: manifest.sessionId,
    deviceId: manifest.deviceId,
    baseline_commit: manifest.baseline_commit,
    phase_inventory: manifest.phase_inventory,
    schema_registry: manifest.schema_registry,
    cli_registry: manifest.cli_registry,
    commit_chain: manifest.commit_chain,
    stale_readiness: manifest.stale_readiness,
    closure_summary: manifest.closure_summary,
    capability_matrix: manifest.capability_matrix,
    boundary_truth: manifest.boundary_truth,
    verification_summary: manifest.verification_summary,
    blocker_summary: manifest.blocker_summary,
    next_phase_recommendations: manifest.next_phase_recommendations,
    unsafe_action_policy: manifest.unsafe_action_policy,
    side_effect_result: manifest.side_effect_result,
  };
}

function runtimeStatusMilestoneRefreshIdempotencyKey(manifest) {
  return `runtime-status-milestone-refresh:${stableHash(canonicalManifestInput(manifest))}`;
}

function buildManifest(options = {}) {
  const contract = options.contract || {};
  const inputSignals = options.inputSignals || {};
  const scope = normalizeScope(inputSignals);
  const generatedAt = generatedAtFromOptions(options, inputSignals);
  const manifest = {
    schema: RUNTIME_STATUS_MILESTONE_REFRESH_MANIFEST_SCHEMA_VERSION,
    version: RUNTIME_STATUS_MILESTONE_REFRESH_VERSION,
    manifest_id: null,
    idempotency_key: null,
    generated_at: generatedAt,
    profile: scope.profile,
    sessionId: scope.sessionId,
    deviceId: scope.deviceId,
    baseline_commit: inputSignals.baseline_commit || BASELINE_COMMIT,
    phase_inventory: asArray(inputSignals.phase_inventory).length > 0
      ? clone(inputSignals.phase_inventory)
      : phaseInventory(contract),
    schema_registry: asArray(inputSignals.schema_registry).length > 0
      ? clone(inputSignals.schema_registry)
      : schemaRegistry(contract),
    cli_registry: asArray(inputSignals.cli_registry).length > 0
      ? clone(inputSignals.cli_registry)
      : cliRegistry(contract),
    commit_chain: asArray(inputSignals.commit_chain).length > 0
      ? clone(inputSignals.commit_chain)
      : clone(contract.commitChainExpected || []),
    stale_readiness: staleReadiness(),
    closure_summary: closureSummary(),
    capability_matrix: capabilityMatrix(),
    boundary_truth: boundaryTruth(),
    verification_summary: verificationSummary(inputSignals),
    blocker_summary: blockerSummary(),
    next_phase_recommendations: nextPhaseRecommendations(contract),
    unsafe_action_policy: unsafeActionPolicy(),
    evidenceRefs: [
      evidenceRef('git', BASELINE_COMMIT, 'phase34-baseline'),
      evidenceRef('mira-core-runtime-status-milestone-refresh-contract', 'phase34-contract'),
    ],
    side_effect_result: sideEffectResult(),
  };
  manifest.idempotency_key = runtimeStatusMilestoneRefreshIdempotencyKey(manifest);
  manifest.manifest_id = `runtime-status-milestone-refresh-${stableHash({
    key: manifest.idempotency_key,
  }).slice(0, 12)}`;
  assertNoForbiddenOutput(manifest, asArray(contract.forbiddenOutputSubstrings));
  return manifest;
}

function literalValuesOk(value, literals = {}) {
  return Object.entries(literals || {}).every(([field, expected]) => valuesMatch(pathValue(value, field), expected));
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

function phaseInventoryOk(manifest, contract = {}) {
  const expected = asArray(contract.phaseRegistryExpected);
  const inventory = asArray(manifest.phase_inventory);
  const requiredFields = asArray(expectedManifestShape(contract).phaseInventoryRequiredFields);
  const capabilityValues = expectedManifestShape(contract).phaseCapabilityTruthRequiredValues || {};
  return expected.length === 33
    && inventory.length === 33
    && valuesMatch(inventory.map((item) => item.phase), Array.from({ length: 33 }, (_value, index) => index + 1))
    && expected.every((expectedItem) => {
      const item = inventory.find((entry) => entry.phase === expectedItem.phase);
      return item
        && hasRequiredFields(item, requiredFields)
        && Object.entries(expectedItem).every(([field, value]) => valuesMatch(item[field], value))
        && Object.entries(capabilityValues).every(([field, value]) => item.capability_truth?.[field] === value)
        && asArray(item.evidenceRefs).length > 0;
    });
}

function schemaRegistryOk(manifest) {
  const registry = asArray(manifest.schema_registry);
  return registry.length === 33
    && valuesMatch(registry.map((entry) => entry.phase), Array.from({ length: 33 }, (_value, index) => index + 1))
    && registry.every((entry) => entry.name && entry.fixture_path && entry.module_path && entry.test_path);
}

function cliRegistryOk(manifest) {
  const registry = asArray(manifest.cli_registry);
  return registry.length === 33
    && valuesMatch(registry.map((entry) => entry.phase), Array.from({ length: 33 }, (_value, index) => index + 1))
    && registry.every((entry) => entry.name
      && entry.cli_path
      && entry.stdout_only_required === true
      && entry.output_behavior === 'stdout_only'
      && entry.side_effects_allowed === false);
}

function commitChainOk(manifest, contract = {}) {
  const expected = asArray(contract.commitChainExpected);
  const chain = asArray(manifest.commit_chain);
  return expected.length === 21
    && chain.length === 21
    && valuesMatch(chain, expected)
    && chain[chain.length - 1] === BASELINE_COMMIT;
}

function stalePhase31Ok(manifest) {
  const stale = manifest.stale_readiness || {};
  const phase31 = asArray(manifest.phase_inventory).find((item) => item.phase === 31);
  return stale.phase31_runtime_milestone_refresh_current === false
    && stale.phase31_superseded_by === 'phase_34_runtime_status_milestone_refresh'
    && phase31?.status === 'stale_superseded_by_phase_34';
}

function stalePhase23Ok(manifest) {
  const stale = manifest.stale_readiness || {};
  const phase13 = asArray(manifest.phase_inventory).find((item) => item.phase === 13);
  const phase23 = asArray(manifest.phase_inventory).find((item) => item.phase === 23);
  return stale.phase13_readiness_current === false
    && stale.phase13_superseded_by === 'phase_23_milestone_readiness'
    && stale.phase23_milestone_readiness_current === false
    && stale.phase23_superseded_by === 'phase_31_runtime_milestone_refresh'
    && phase13?.status === 'stale_superseded_by_phase_23_and_phase_31'
    && phase23?.status === 'stale_superseded_by_phase_31';
}

function phase30ClosureOk(manifest) {
  const closure = manifest.closure_summary || {};
  return closure.phase30_oracle_115_prerequisite_mapping_closure === true
    && closure.phase30_recomputed_idempotency_bogus_mapping_rejected === true
    && asArray(closure.closed_review_refs).includes('ORACLE #115');
}

function phase32ClosureOk(manifest) {
  const closure = manifest.closure_summary || {};
  return closure.phase32_oracle_123_expires_at_closure === true
    && closure.phase32_expires_at_bound_to_generated_at === true
    && asArray(closure.closed_review_refs).includes('ORACLE #123');
}

function phase33ClosureOk(manifest) {
  const closure = manifest.closure_summary || {};
  return closure.phase33_oracle_127_validation_report_tamper_coverage_closure === true
    && closure.phase33_static_acceptance_ok_values_recomputed === true
    && closure.phase33_tamper_results_bound_to_fixture === true
    && asArray(closure.closed_review_refs).includes('ORACLE #127');
}

function capabilityTruthOk(manifest, contract = {}) {
  const phaseValues = expectedManifestShape(contract).phaseCapabilityTruthRequiredValues || {};
  const phaseTruthOk = asArray(manifest.phase_inventory).every((item) => Object.entries(phaseValues)
    .every(([field, value]) => item.capability_truth?.[field] === value));
  const capability = manifest.capability_matrix || {};
  return phaseTruthOk
    && capability.runtimeStarted === false
    && capability.runnerExecuted === false
    && capability.runtimeAvailable === false
    && capability.realRuntimeAvailable === false
    && capability.serverCanExecuteLocal === false
    && capability.serverCanProveModelProcessing === false
    && capability.directBuilderOracleServerTargetsAllowed === false;
}

function proofBoundariesOk(manifest) {
  const boundary = manifest.boundary_truth || {};
  return boundary.runtimeStarted === false
    && boundary.runnerExecuted === false
    && boundary.runtimeAvailable === false
    && boundary.serverCanExecuteLocal === false
    && boundary.serverCanProveModelProcessing === false
    && boundary.builderOracleDirectServerTargetsAllowed === false
    && boundary.socketIsBridgeGreenProof === false
    && boundary.deliveryAcceptanceIsModelProcessingProof === false
    && boundary.statusSurfaceIsRuntimeProof === false
    && boundary.dryRunnerContractIsRunnerExecutionProof === false;
}

function verificationTruthOk(manifest) {
  const summary = manifest.verification_summary || {};
  const reported = asArray(summary.reported_commands);
  if (summary.no_fake_test_proof !== true) return false;
  if (summary.proof_status === 'proven_by_reported_command') {
    return reported.length > 0
      && reported.every((command) => command.result === 'PASS' && Number(command.failed_count || 0) === 0);
  }
  return summary.unknown_or_degraded_proof === true;
}

function nextRecommendationsOk(manifest, contract = {}) {
  const expected = asArray(contract.nextRecommendationExpectedCandidates);
  const recommendations = asArray(manifest.next_phase_recommendations);
  return recommendations.length >= Number(expectedManifestShape(contract).expectedCounts?.next_phase_recommendations_min || 0)
    && expected.every((candidate) => recommendations.some((recommendation) => (
      recommendation.recommendation_id === candidate.recommendation_id
        && recommendation.tier === candidate.tier
        && recommendation.action === candidate.action
        && recommendation.why_safe === candidate.why_safe
        && recommendation.does_not_authorize_runtime === true
    )))
    && recommendations.every((recommendation) => ['tier0', 'tier1'].includes(recommendation.tier)
      && recommendation.does_not_authorize_runtime === true
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
  const before = String(text || '').slice(Math.max(0, index - 100), index);
  return /\b(no|without|blocked|blocks|disallow|disallowed|not|cannot|does not|must not)\b[^.;:]*$/i.test(before);
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

function unsafeActionDriftOk(manifest, contract = {}) {
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
    'live ui',
    'live runtime',
  ];
  const phraseNeedles = asArray(contract.unsafeActionPhrases).map((phrase) => String(phrase || '').toLowerCase());
  const strings = [
    ...collectStringValues(manifest.next_phase_recommendations),
    ...collectStringValues(manifest.blocker_summary),
    ...collectStringValues(manifest.verification_summary),
    ...collectStringValues(manifest.closure_summary),
  ];
  return strings.every((text) => {
    const lower = String(text || '').toLowerCase();
    return !unsafeTerms.some((term) => hasUnsafeTerm(lower, term))
      && !hasOutboundRecipientIntent(lower)
      && !phraseNeedles.some((phrase) => hasUnsafeTerm(lower, phrase));
  });
}

function referencedPathResults(manifest = {}, projectRoot = PROJECT_ROOT) {
  const seen = new Set();
  const results = [];
  for (const item of asArray(manifest.phase_inventory)) {
    for (const field of ['fixture_path', 'module_path', 'cli_path', 'test_path']) {
      const refPath = item[field];
      if (!refPath || seen.has(refPath)) continue;
      seen.add(refPath);
      results.push({
        path: refPath,
        exists: fs.existsSync(path.resolve(projectRoot, refPath)),
      });
    }
  }
  return results;
}

function referencedPathsOk(manifest, projectRoot = PROJECT_ROOT) {
  const results = referencedPathResults(manifest, projectRoot);
  return results.length === 33 * 4 && results.every((entry) => entry.exists === true);
}

function assertNoForbiddenOutput(value, extraForbidden = []) {
  const strings = collectStringValues(value);
  for (const forbidden of [...DEFAULT_FORBIDDEN_OUTPUT_SUBSTRINGS, ...extraForbidden]) {
    if (!forbidden) continue;
    const needle = String(forbidden).toLowerCase();
    if (strings.some((entry) => String(entry).toLowerCase().includes(needle))) {
      throw new Error(`runtime_status_milestone_refresh_forbidden_substring:${forbidden}`);
    }
  }
}

function validateManifest(manifest = {}, contract = {}, options = {}) {
  const checks = [];
  const errors = [];
  const resultById = {};
  const add = (id, ok) => {
    const result = resultObject(id, ok);
    checks.push(result);
    resultById[id] = result;
    if (!ok) errors.push(id);
  };

  const outputShapeOk = manifest.schema === RUNTIME_STATUS_MILESTONE_REFRESH_MANIFEST_SCHEMA_VERSION
    && hasRequiredFields(manifest, expectedManifestShape(contract).requiredFields || REQUIRED_MANIFEST_FIELDS);
  const baselineOk = manifest.baseline_commit === BASELINE_COMMIT;
  const inventoryOk = phaseInventoryOk(manifest, contract);
  const schemaOk = schemaRegistryOk(manifest);
  const cliOk = cliRegistryOk(manifest);
  const chainOk = commitChainOk(manifest, contract);
  const phase31Ok = stalePhase31Ok(manifest);
  const phase23Ok = stalePhase23Ok(manifest);
  const closure30Ok = phase30ClosureOk(manifest);
  const closure32Ok = phase32ClosureOk(manifest);
  const closure33Ok = phase33ClosureOk(manifest);
  const capabilityOk = capabilityTruthOk(manifest, contract);
  const proofOk = proofBoundariesOk(manifest) && verificationTruthOk(manifest);
  const sideEffectOk = sideEffectValuesOk(manifest.side_effect_result);
  const recommendationOk = nextRecommendationsOk(manifest, contract);
  const unsafeOk = unsafeActionDriftOk(manifest, contract);
  const pathsOk = referencedPathsOk(manifest, options.projectRoot || PROJECT_ROOT);
  let forbiddenOk = true;
  try {
    assertNoForbiddenOutput(manifest, asArray(contract.forbiddenOutputSubstrings));
  } catch {
    forbiddenOk = false;
  }
  const idempotencyOk = manifest.idempotency_key === runtimeStatusMilestoneRefreshIdempotencyKey(manifest);
  const literalsOk = literalValuesOk(manifest, expectedManifestShape(contract).requiredLiteralValues || {});

  const staticRuleOk = {
    'baseline-pinned': baselineOk,
    'phase-inventory-count-33': inventoryOk,
    'schema-registry-count-33': schemaOk,
    'cli-registry-count-33': cliOk,
    'commit-chain-exact': chainOk,
    'phase31-stale-superseded': phase31Ok,
    'phase23-stale-preserved': phase23Ok,
    'phase30-oracle115-closure-carried': closure30Ok,
    'phase32-oracle123-closure-carried': closure32Ok,
    'phase33-oracle127-closure-carried': closure33Ok,
    'capability-truth-false': capabilityOk,
    'proof-boundaries-false': proofOk,
    'side-effect-truth-all-blocked': sideEffectOk,
    'next-recommendations-tier0-tier1-only': recommendationOk,
    'unsafe-action-drift-blocked': unsafeOk,
    'referenced-paths-exist': pathsOk,
    'no-raw-private-secret-output': forbiddenOk,
    'idempotency-sensitive': idempotencyOk,
  };

  const acceptanceOk = {
    'baseline-0e82768-pinned': baselineOk,
    'phase-inventory-exactly-33': inventoryOk,
    'schema-registry-exactly-33': schemaOk,
    'cli-registry-exactly-33': cliOk,
    'commit-chain-ends-0e82768': chainOk,
    'phase31-stale-superseded-by-phase34': phase31Ok,
    'phase23-stale-truth-preserved': phase23Ok,
    'phase30-oracle115-closure-present': closure30Ok,
    'phase32-oracle123-closure-present': closure32Ok,
    'phase33-oracle127-closure-present': closure33Ok,
    'runtime-started-false': manifest.capability_matrix?.runtimeStarted === false && manifest.boundary_truth?.runtimeStarted === false,
    'runner-executed-false': manifest.capability_matrix?.runnerExecuted === false && manifest.boundary_truth?.runnerExecuted === false,
    'runtime-available-false': manifest.capability_matrix?.runtimeAvailable === false && manifest.boundary_truth?.runtimeAvailable === false,
    'server-can-execute-local-false': manifest.capability_matrix?.serverCanExecuteLocal === false && manifest.boundary_truth?.serverCanExecuteLocal === false,
    'server-can-prove-model-processing-false': manifest.capability_matrix?.serverCanProveModelProcessing === false && manifest.boundary_truth?.serverCanProveModelProcessing === false,
    'builder-oracle-direct-targets-blocked': manifest.capability_matrix?.directBuilderOracleServerTargetsAllowed === false
      && manifest.boundary_truth?.builderOracleDirectServerTargetsAllowed === false,
    'proof-boundaries-false': proofOk,
    'side-effect-truth-all-blocked': sideEffectOk,
    'next-recommendations-tier0-tier1-only': recommendationOk,
    'unsafe-action-drift-rejected': unsafeOk,
    'referenced-paths-exist': pathsOk,
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
    && idsEqual(list, 'id', tamperCases.map((item) => item.id))
    && list.every((entry) => {
      const expected = tamperCases.find((item) => item.id === entry.id);
      return expected
        && entry.covered === true
        && entry.expectedFailure === expected.expectedFailure;
    });
}

function referencedPathResultsMatch(results = [], recomputed = []) {
  return valuesMatch(asArray(results), asArray(recomputed));
}

function buildValidationReport(manifest, contract = {}, generatedAt = manifest.generated_at, options = {}) {
  const validation = validateManifest(manifest, contract, options);
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
    version: RUNTIME_STATUS_MILESTONE_REFRESH_VERSION,
    validation_id: `runtime-status-milestone-refresh-validation-${stableHash({
      manifest_key: manifest.idempotency_key,
      generatedAt,
    }).slice(0, 12)}`,
    generated_at: generatedAt,
    fixture_ref: 'ui/__tests__/fixtures/mira-core-runtime-status-milestone-refresh-contract.json',
    baseline_commit: BASELINE_COMMIT,
    decision: validation.ok ? 'accepted_validation_only' : 'rejected',
    accepted: validation.ok,
    blocked: !validation.ok,
    reasons: failed.map((check) => check.id),
    static_rule_results: staticResults,
    acceptance_check_results: acceptanceResults,
    tamper_case_results: tamperResults,
    referenced_path_results: referencedPathResults(manifest, options.projectRoot || PROJECT_ROOT),
    forbidden_output_scan: resultObject('forbidden-output-strings-absent', validation.resultById['no-raw-private-secret-output']?.ok),
    side_effect_truth: sideEffectResult(),
    summary: {
      phase_inventory_count: asArray(manifest.phase_inventory).length,
      schema_registry_count: asArray(manifest.schema_registry).length,
      cli_registry_count: asArray(manifest.cli_registry).length,
      commit_chain_count: asArray(manifest.commit_chain).length,
      baseline_commit: manifest.baseline_commit,
      accepted_validation_only: validation.ok,
    },
  };
  assertNoForbiddenOutput(report, asArray(contract.forbiddenOutputSubstrings));
  return report;
}

function buildMiraCoreRuntimeStatusMilestoneRefresh(options = {}) {
  const contract = options.contract || {};
  const manifest = buildManifest(options);
  const validation_report = buildValidationReport(
    manifest,
    contract,
    manifest.generated_at,
    { projectRoot: options.projectRoot },
  );
  const output = {
    runtime_status_milestone_refresh_manifest: manifest,
    validation_report,
  };
  assertNoForbiddenOutput(output, asArray(contract.forbiddenOutputSubstrings));
  return output;
}

function validateMiraCoreRuntimeStatusMilestoneRefreshOutput(output = {}, contract = {}, options = {}) {
  const checks = [];
  const errors = [];
  const add = (id, ok) => {
    checks.push({ id, ok: ok === true });
    if (!ok) errors.push(id);
  };
  const manifest = output.runtime_status_milestone_refresh_manifest || {};
  const report = output.validation_report || {};
  const manifestValidation = validateManifest(manifest, contract, { projectRoot: options.projectRoot });
  const recomputedPathResults = referencedPathResults(manifest, options.projectRoot || PROJECT_ROOT);
  const recomputedById = manifestValidation.checks.reduce((acc, check) => {
    acc[check.id] = check;
    return acc;
  }, {});

  add('output-shape-complete',
    hasRequiredFields(output, contract.expectedOutputShape?.requiredTopLevelFields || REQUIRED_OUTPUT_FIELDS)
      && manifest.schema === RUNTIME_STATUS_MILESTONE_REFRESH_MANIFEST_SCHEMA_VERSION
      && report.schema === VALIDATION_REPORT_SCHEMA_VERSION
      && hasRequiredFields(manifest, contract.expectedManifestShape?.requiredFields || REQUIRED_MANIFEST_FIELDS)
      && hasRequiredFields(report, contract.expectedValidationReportShape?.requiredFields || REQUIRED_VALIDATION_REPORT_FIELDS));

  for (const check of manifestValidation.checks) add(check.id, check.ok);

  add('validation-report-literal-values',
    report.schema === VALIDATION_REPORT_SCHEMA_VERSION
      && report.baseline_commit === BASELINE_COMMIT
      && literalValuesOk(report, validationShape(contract).requiredLiteralValues || {}));

  add('validation-report-side-effect-truth', sideEffectValuesOk(report.side_effect_truth));

  add('validation-report-matches-contract',
    report.accepted === manifestValidation.ok
      && report.blocked === !manifestValidation.ok
      && report.decision === (manifestValidation.ok ? 'accepted_validation_only' : 'rejected')
      && valuesMatch(asArray(report.reasons), manifestValidation.checks.filter((check) => !check.ok).map((check) => check.id))
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
      && referencedPathResultsMatch(report.referenced_path_results, recomputedPathResults)
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
  REQUIRED_MANIFEST_FIELDS,
  REQUIRED_OUTPUT_FIELDS,
  REQUIRED_SIDE_EFFECT_FIELDS,
  REQUIRED_VALIDATION_REPORT_FIELDS,
  RUNTIME_STATUS_MILESTONE_REFRESH_MANIFEST_SCHEMA_VERSION,
  VALIDATION_REPORT_SCHEMA_VERSION,
  assertNoForbiddenOutput,
  buildMiraCoreRuntimeStatusMilestoneRefresh,
  runtimeStatusMilestoneRefreshIdempotencyKey,
  stableHash,
  validateMiraCoreRuntimeStatusMilestoneRefreshOutput,
};
