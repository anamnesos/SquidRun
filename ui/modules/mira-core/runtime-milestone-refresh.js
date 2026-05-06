'use strict';

const crypto = require('crypto');

const RUNTIME_MILESTONE_REFRESH_MANIFEST_SCHEMA_VERSION = 'squidrun.mira_core.runtime_milestone_refresh_manifest.v0';
const VALIDATION_REPORT_SCHEMA_VERSION = 'squidrun.mira_core.runtime_milestone_refresh_validation_report.v0';
const RUNTIME_MILESTONE_REFRESH_VERSION = 'v0';
const BASELINE_COMMIT = '679e018';

const REQUIRED_OUTPUT_FIELDS = Object.freeze([
  'runtime_milestone_refresh_manifest',
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
  'commit_chain',
  'schema_registry',
  'cli_registry',
  'capability_matrix',
  'boundary_truth',
  'stale_readiness',
  'phase_22_closure',
  'phase_30_closure',
  'runtime_control_path_summary',
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
  'fixture_ref',
  'baseline_commit',
  'accepted',
  'decision',
  'reasons',
  'checks',
  'phase_inventory_count',
  'schema_registry_count',
  'cli_registry_count',
  'commit_chain_count',
  'stale_readiness_result',
  'phase_30_closure_result',
  'capability_truth_result',
  'unsafe_action_result',
  'side_effect_result',
  'evidenceRefs',
]);

const REQUIRED_SIDE_EFFECT_FIELDS = Object.freeze([
  'no_runtime_performed',
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
  'no_send_performed',
  'no_deploy_performed',
  'no_trade_performed',
  'no_output_file_written',
]);

const SIDE_EFFECT_COUNTER_FIELDS = Object.freeze([
  'runtimeAttempts',
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
  'sendsAttempted',
  'deploysAttempted',
  'tradesAttempted',
  'outputFilesWritten',
]);

const SIDE_EFFECT_REQUIRED_FALSE_FIELDS = Object.freeze([
  'runtimeStarted',
  'serverStarted',
  'outputFileWritten',
]);

const SIDE_EFFECT_REQUIRED_ZERO_FIELDS = Object.freeze([
  'listenersBound',
  'networkCallsMade',
  'filesWritten',
  'outputFilesWritten',
]);

const CAPABILITY_TRUTH = Object.freeze({
  runtime_started: false,
  runtime_available_now: false,
  eligible_is_authorization: false,
  serverCanExecuteLocal: false,
  serverCanProveModelProcessing: false,
  directBuilderOracleServerTargetsAllowed: false,
});

const DEFAULT_FORBIDDEN_OUTPUT_SUBSTRINGS = Object.freeze([
  'bearer token',
  'api key',
  'private key',
  'data key',
  'session secret',
  'env secret',
  'raw terminal',
  'terminal scrollback',
  'raw screenshot',
  'raw OCR',
  'browser cookie',
  'browser DOM',
  'customer private',
  'side profile payload',
  'decrypted payload',
  'raw comms body',
  'runtime started',
  'server started',
  'listener bound',
  'network request sent',
  'database write',
  'store write',
  'file written',
  'output file written',
  'queue created',
  'lease created',
  'local execution performed',
  'shell executed',
  'PTY executed',
  'customer send performed',
  'external send performed',
  'deploy performed',
  'trade performed',
  'runtime is available',
  'socket proves bridge green',
  'delivery acceptance proves model processing',
  'Builder direct target allowed',
  'Oracle direct target allowed',
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

function evidenceRef(store, eventId, relation = 'runtime_milestone_refresh_validation') {
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

function expectedShape(contract = {}) {
  return contract.expectedRuntimeMilestoneRefreshManifestShape || {};
}

function phaseInventory(contract = {}) {
  return asArray(expectedShape(contract).phaseInventoryExpected).map((item) => ({
    ...clone(item),
    capability_truth: {
      ...CAPABILITY_TRUTH,
      localArmsProofSeparate: true,
    },
    evidenceRefs: [
      evidenceRef('mira-core-runtime-phase-registry', `phase:${item.phase}`),
    ],
  }));
}

function schemaRegistry(contract = {}) {
  return clone(expectedShape(contract).schemaRegistryExpected || []);
}

function cliRegistry(contract = {}) {
  return clone(expectedShape(contract).cliRegistryExpected || []);
}

function commitChain(contract = {}) {
  return clone(expectedShape(contract).commitChainExpected || []);
}

function capabilityMatrix() {
  return {
    runtime_started: false,
    runtime_available_now: false,
    realRuntimeAvailable: false,
    eligible_is_authorization: false,
    serverCanExecuteLocal: false,
    serverCanProveModelProcessing: false,
    directBuilderOracleServerTargetsAllowed: false,
    localArmsProofSeparate: true,
    allowed_next_tiers: ['Tier0', 'Tier1'],
    blocked_capabilities: [
      'runtime-mode-enable',
      'listener-or-route',
      'network-transport',
      'durable-store',
      'queue-or-lease',
      'auth-key-secret',
      'local-shell-pty',
      'external-action',
      'durable-memory-profile',
    ],
    evidenceRefs: [
      evidenceRef('mira-core-runtime-milestone-refresh', 'capability-matrix'),
    ],
  };
}

function boundaryTruth() {
  return {
    runtimeStarted: false,
    runtimeAvailableNow: false,
    eligibleIsAuthorization: false,
    serverCanExecuteLocal: false,
    serverCanProveModelProcessing: false,
    builderOracleDirectServerTargetsAllowed: false,
    socketIsBridgeGreenProof: false,
    deliveryAcceptanceIsModelProcessingProof: false,
    controlPathIsRuntimeProof: false,
    localArmsProofSeparate: true,
    evidenceRefs: [
      evidenceRef('mira-core-runtime-milestone-refresh', 'boundary-truth'),
    ],
  };
}

function staleReadiness() {
  return {
    phase13ReadinessCurrent: false,
    phase13SupersededBy: 'phase_23_milestone_readiness',
    phase23MilestoneReadinessCurrent: false,
    phase23SupersededBy: 'phase_31_runtime_milestone_refresh',
    phase13Reason: 'phase_13_indexed_phases_1_12_only',
    phase23Reason: 'phase_23_indexed_phases_1_22_only',
    evidenceRefs: [
      evidenceRef('mira-core-readiness', 'phase13-stale'),
      evidenceRef('mira-core-milestone-readiness', 'phase23-stale'),
    ],
  };
}

function phase22Closure() {
  return {
    validation_only: true,
    oracle_78_79_80_bypasses_closed: true,
    direct_request_case_binding: true,
    same_sequence_decision_binding: true,
    recomputed_idempotency_regressions_present: true,
    closed_review_refs: ['ORACLE #78', 'ORACLE #79', 'ORACLE #80'],
    evidenceRefs: [
      evidenceRef('mira-core-runtime-harness', 'oracle-78-79-80-closure'),
    ],
  };
}

function phase30Closure() {
  return {
    validation_only: true,
    oracle_115_phase29_mapping_bypass_closed: true,
    phase29_prerequisite_mapping_exact: true,
    recomputed_idempotency_bogus_mapping_rejected: true,
    runtime_started: false,
    runtime_available_now: false,
    serverCanExecuteLocal: false,
    closed_review_refs: ['ORACLE #115', 'ORACLE #116'],
    evidenceRefs: [
      evidenceRef('mira-core-runtime-control-path', 'oracle-115-closure'),
      evidenceRef('git', BASELINE_COMMIT, 'phase30-commit'),
    ],
  };
}

function runtimeControlPathSummary() {
  return {
    phase: 30,
    commit: BASELINE_COMMIT,
    default_decision: 'remain_control_path_contract_only',
    runtime_started: false,
    runtime_available_now: false,
    eligible_is_authorization: false,
    serverCanExecuteLocal: false,
    validation_only: true,
    evidenceRefs: [
      evidenceRef('mira-core-runtime-control-path', 'phase30-summary'),
    ],
  };
}

function verificationSummary(inputSignals = {}) {
  const commands = asArray(inputSignals.verification?.commands);
  const proven = commands.length > 0 && commands.every((command) => command.result === 'PASS' && Number(command.failed_count || 0) === 0);
  return {
    no_fake_test_proof: true,
    proof_status: proven ? 'proven_by_reported_command' : 'unknown_without_phase31_command_input',
    reported_commands: clone(commands),
    prior_phase30_reported: {
      targeted: '16/16',
      combined: '490/490',
      source: 'builder_report_before_phase31',
    },
    unknown_or_degraded_proof: !proven,
    evidenceRefs: [
      evidenceRef('mira-core-runtime-milestone-refresh', 'verification-summary'),
    ],
  };
}

function blockerSummary(contract = {}) {
  return asArray(expectedShape(contract).blockerSummaryRequired).map((blockerId) => ({
    blocker_id: blockerId,
    severity: blockerId === 'operator_status_ui_not_built' ? 'medium' : 'high',
    status: 'blocking_future_runtime_slice',
    blocked_because: `Required gate remains open: ${blockerId}.`,
    safe_next_action: 'Keep this as validation metadata and review a fixture-only follow-up.',
    evidenceRefs: [
      evidenceRef('mira-core-runtime-milestone-refresh', `blocker:${blockerId}`),
    ],
  }));
}

function nextPhaseRecommendations(contract = {}) {
  const prerequisites = [
    'Phase 31 accepted',
    'Operator review of disabled local validation path',
  ];
  return asArray(expectedShape(contract).nextRecommendationExpectedCandidates).map((candidate) => ({
    ...clone(candidate),
    why_safe: 'It is fixture-only validation planning with no side-effect path.',
    blocked_side_effects: [
      'runtime',
      'transport',
      'persistent mutation',
      'local arm action',
      'external action',
    ],
    prerequisites: clone(prerequisites),
    evidenceRefs: [
      evidenceRef('mira-core-runtime-milestone-refresh', `next:${candidate.recommendation_id}`),
    ],
  }));
}

function unsafeActionPolicy(contract = {}) {
  return {
    ...clone(expectedShape(contract).unsafeActionPolicyRequiredValues || {}),
    evidenceRefs: [
      evidenceRef('mira-core-runtime-milestone-refresh', 'unsafe-action-policy'),
    ],
  };
}

function sideEffectResult() {
  return {
    no_runtime_performed: true,
    no_server_performed: true,
    no_listener_or_route_bound: true,
    no_network_performed: true,
    no_database_write_performed: true,
    no_store_write_performed: true,
    no_file_write_performed: true,
    no_migration_executed: true,
    no_queue_created: true,
    no_lease_created: true,
    no_auth_change_performed: true,
    no_key_secret_operation_performed: true,
    no_local_execution_performed: true,
    no_send_performed: true,
    no_deploy_performed: true,
    no_trade_performed: true,
    no_output_file_written: true,
    runtimeAttempts: 0,
    serverAttempts: 0,
    listenerRouteAttempts: 0,
    networkRequestsAttempted: 0,
    databaseWritesAttempted: 0,
    storeWritesAttempted: 0,
    fileWritesAttempted: 0,
    migrationsAttempted: 0,
    queuesCreated: 0,
    leasesCreated: 0,
    authChangesAttempted: 0,
    keySecretOperationsAttempted: 0,
    localExecutionAttempted: 0,
    sendsAttempted: 0,
    deploysAttempted: 0,
    tradesAttempted: 0,
    outputFilesWritten: 0,
    runtimeStarted: false,
    serverStarted: false,
    listenersBound: 0,
    networkCallsMade: 0,
    filesWritten: 0,
    outputFileWritten: false,
  };
}

function canonicalManifestInput(manifest) {
  return {
    baseline_commit: manifest.baseline_commit,
    profile: manifest.profile,
    sessionId: manifest.sessionId,
    deviceId: manifest.deviceId,
    phase_inventory: manifest.phase_inventory,
    commit_chain: manifest.commit_chain,
    schema_registry: manifest.schema_registry,
    cli_registry: manifest.cli_registry,
    capability_matrix: manifest.capability_matrix,
    boundary_truth: manifest.boundary_truth,
    stale_readiness: manifest.stale_readiness,
    phase_22_closure: manifest.phase_22_closure,
    phase_30_closure: manifest.phase_30_closure,
    runtime_control_path_summary: manifest.runtime_control_path_summary,
    blocker_summary: manifest.blocker_summary,
    next_phase_recommendations: manifest.next_phase_recommendations,
    unsafe_action_policy: manifest.unsafe_action_policy,
    side_effect_result: manifest.side_effect_result,
  };
}

function runtimeMilestoneRefreshIdempotencyKey(manifest) {
  return `runtime-milestone-refresh:${stableHash(canonicalManifestInput(manifest))}`;
}

function buildManifest(options = {}) {
  const contract = options.contract || {};
  const inputSignals = options.inputSignals || {};
  const scope = normalizeScope(inputSignals);
  const generatedAt = generatedAtFromOptions(options, inputSignals);
  const inventory = asArray(inputSignals.phase_inventory).length > 0 ? clone(inputSignals.phase_inventory) : phaseInventory(contract);
  const schemas = asArray(inputSignals.schema_registry).length > 0 ? clone(inputSignals.schema_registry) : schemaRegistry(contract);
  const clis = asArray(inputSignals.cli_registry).length > 0 ? clone(inputSignals.cli_registry) : cliRegistry(contract);
  const manifest = {
    schema: RUNTIME_MILESTONE_REFRESH_MANIFEST_SCHEMA_VERSION,
    version: RUNTIME_MILESTONE_REFRESH_VERSION,
    manifest_id: null,
    idempotency_key: null,
    generated_at: generatedAt,
    profile: scope.profile,
    sessionId: scope.sessionId,
    deviceId: scope.deviceId,
    baseline_commit: inputSignals.baseline_commit || BASELINE_COMMIT,
    phase_inventory: inventory,
    commit_chain: asArray(inputSignals.commit_chain).length > 0 ? clone(inputSignals.commit_chain) : commitChain(contract),
    schema_registry: schemas,
    cli_registry: clis,
    capability_matrix: capabilityMatrix(),
    boundary_truth: boundaryTruth(),
    stale_readiness: staleReadiness(),
    phase_22_closure: phase22Closure(),
    phase_30_closure: phase30Closure(),
    runtime_control_path_summary: runtimeControlPathSummary(),
    verification_summary: verificationSummary(inputSignals),
    blocker_summary: blockerSummary(contract),
    next_phase_recommendations: nextPhaseRecommendations(contract),
    unsafe_action_policy: unsafeActionPolicy(contract),
    evidenceRefs: [
      evidenceRef('git', BASELINE_COMMIT, 'phase31-baseline'),
      evidenceRef('mira-core-runtime-milestone-refresh-contract', 'phase31-contract'),
    ],
    side_effect_result: sideEffectResult(),
  };
  manifest.idempotency_key = runtimeMilestoneRefreshIdempotencyKey(manifest);
  manifest.manifest_id = `runtime-milestone-refresh-${stableHash({
    key: manifest.idempotency_key,
    generatedAt,
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
    && SIDE_EFFECT_REQUIRED_FALSE_FIELDS.every((field) => value[field] === false)
    && SIDE_EFFECT_REQUIRED_ZERO_FIELDS.every((field) => Number(value[field] || 0) === 0);
}

function phaseInventoryOk(manifest, contract = {}) {
  const expected = asArray(expectedShape(contract).phaseInventoryExpected);
  const inventory = asArray(manifest.phase_inventory);
  const expectedFields = asArray(expectedShape(contract).phaseInventoryRequiredFields);
  const truthValues = expectedShape(contract).phaseCapabilityTruthRequiredValues || {};
  return expected.length === 30
    && inventory.length === 30
    && valuesMatch(inventory.map((item) => item.phase), Array.from({ length: 30 }, (_value, index) => index + 1))
    && expected.every((expectedItem) => {
      const item = inventory.find((entry) => entry.phase === expectedItem.phase);
      return item
        && hasRequiredFields(item, expectedFields)
        && Object.entries(expectedItem).every(([field, value]) => valuesMatch(item[field], value))
        && Object.entries(truthValues).every(([field, value]) => item.capability_truth?.[field] === value)
        && item.capability_truth?.localArmsProofSeparate === true
        && asArray(item.evidenceRefs).length > 0;
    });
}

function schemaRegistryOk(manifest, contract = {}) {
  const expected = asArray(expectedShape(contract).schemaRegistryExpected);
  const registry = asArray(manifest.schema_registry);
  const fields = asArray(expectedShape(contract).schemaRegistryRequiredFields);
  return registry.length === 30
    && valuesMatch(registry, expected)
    && registry.every((entry) => hasRequiredFields(entry, fields));
}

function cliRegistryOk(manifest, contract = {}) {
  const expected = asArray(expectedShape(contract).cliRegistryExpected);
  const registry = asArray(manifest.cli_registry);
  const fields = asArray(expectedShape(contract).cliRegistryRequiredFields);
  return registry.length === 30
    && valuesMatch(registry, expected)
    && registry.every((entry) => hasRequiredFields(entry, fields)
      && entry.stdout_only_required === true
      && entry.output_file_behavior === 'no_output_file'
      && entry.runtime_side_effects_allowed === false);
}

function commitChainOk(manifest, contract = {}) {
  const expected = asArray(expectedShape(contract).commitChainExpected);
  return expected.length === 18
    && asArray(manifest.commit_chain).length === 18
    && valuesMatch(manifest.commit_chain, expected)
    && manifest.commit_chain[manifest.commit_chain.length - 1]?.commit === BASELINE_COMMIT;
}

function staleReadinessOk(manifest) {
  const phase13 = asArray(manifest.phase_inventory).find((item) => item.phase === 13);
  const phase23 = asArray(manifest.phase_inventory).find((item) => item.phase === 23);
  const stale = manifest.stale_readiness || {};
  return stale.phase13ReadinessCurrent === false
    && stale.phase13SupersededBy === 'phase_23_milestone_readiness'
    && stale.phase23MilestoneReadinessCurrent === false
    && stale.phase23SupersededBy === 'phase_31_runtime_milestone_refresh'
    && phase13?.status === 'stale_superseded_by_phase_23_and_phase_31'
    && phase23?.status === 'stale_superseded_by_phase_31'
    && asArray(stale.evidenceRefs).length > 0;
}

function phase30ClosureOk(manifest) {
  const closure = manifest.phase_30_closure || {};
  return closure.validation_only === true
    && closure.oracle_115_phase29_mapping_bypass_closed === true
    && closure.phase29_prerequisite_mapping_exact === true
    && closure.recomputed_idempotency_bogus_mapping_rejected === true
    && closure.runtime_started === false
    && closure.runtime_available_now === false
    && closure.serverCanExecuteLocal === false
    && asArray(closure.closed_review_refs).includes('ORACLE #115')
    && asArray(closure.evidenceRefs).length > 0;
}

function phase22ClosureOk(manifest) {
  const closure = manifest.phase_22_closure || {};
  return closure.validation_only === true
    && closure.oracle_78_79_80_bypasses_closed === true
    && closure.direct_request_case_binding === true
    && closure.same_sequence_decision_binding === true
    && closure.recomputed_idempotency_regressions_present === true
    && asArray(closure.closed_review_refs).includes('ORACLE #78')
    && asArray(closure.closed_review_refs).includes('ORACLE #79')
    && asArray(closure.closed_review_refs).includes('ORACLE #80');
}

function runtimeControlPathOk(manifest) {
  const summary = manifest.runtime_control_path_summary || {};
  return summary.default_decision === 'remain_control_path_contract_only'
    && summary.runtime_started === false
    && summary.runtime_available_now === false
    && summary.eligible_is_authorization === false
    && summary.serverCanExecuteLocal === false
    && summary.validation_only === true
    && manifest.capability_matrix?.runtime_started === false
    && manifest.capability_matrix?.runtime_available_now === false
    && manifest.capability_matrix?.eligible_is_authorization === false
    && manifest.boundary_truth?.runtimeStarted === false
    && manifest.boundary_truth?.runtimeAvailableNow === false
    && manifest.boundary_truth?.eligibleIsAuthorization === false
    && manifest.boundary_truth?.controlPathIsRuntimeProof === false;
}

function capabilityTruthOk(manifest) {
  return manifest.capability_matrix?.runtime_started === false
    && manifest.capability_matrix?.runtime_available_now === false
    && manifest.capability_matrix?.realRuntimeAvailable === false
    && manifest.capability_matrix?.eligible_is_authorization === false
    && manifest.capability_matrix?.serverCanExecuteLocal === false
    && manifest.capability_matrix?.serverCanProveModelProcessing === false
    && manifest.capability_matrix?.directBuilderOracleServerTargetsAllowed === false
    && manifest.capability_matrix?.localArmsProofSeparate === true
    && manifest.boundary_truth?.serverCanExecuteLocal === false
    && manifest.boundary_truth?.serverCanProveModelProcessing === false
    && manifest.boundary_truth?.builderOracleDirectServerTargetsAllowed === false
    && manifest.boundary_truth?.socketIsBridgeGreenProof === false
    && manifest.boundary_truth?.deliveryAcceptanceIsModelProcessingProof === false
    && manifest.boundary_truth?.controlPathIsRuntimeProof === false;
}

function blockerSummaryOk(manifest, contract = {}) {
  const required = asArray(expectedShape(contract).blockerSummaryRequired);
  const blockers = asArray(manifest.blocker_summary);
  return blockers.length >= Number(expectedShape(contract).expectedCounts?.blocker_summary_min || 0)
    && required.every((id) => blockers.some((blocker) => blocker.blocker_id === id
      && blocker.status
      && blocker.blocked_because
      && blocker.safe_next_action
      && asArray(blocker.evidenceRefs).length > 0));
}

function unsafeActionPolicyOk(manifest, contract = {}) {
  const policy = manifest.unsafe_action_policy || {};
  return Object.entries(expectedShape(contract).unsafeActionPolicyRequiredValues || {})
    .every(([field, value]) => valuesMatch(policy[field], value));
}

function unsafeActionDriftOk(manifest) {
  const unsafePattern = /\b(tier[234]|runtime authorized|deploy|trade|money|move money|external send|memory commit|profile commit|capture|local execution|shell|pty)\b/i;
  const outboundTerms = new Set(['send', 'sent', 'sending', 'email', 'message', 'messaging', 'contact', 'reply', 'outbound']);
  const recipientTerms = new Set(['customer', 'customers', 'client', 'clients', 'contact', 'contacts', 'recipient', 'recipients']);
  const hasOutboundRecipientIntent = (text) => {
    const tokens = String(text || '').toLowerCase().match(/[a-z0-9]+/g) || [];
    return tokens.some((token) => outboundTerms.has(token))
      && tokens.some((token) => recipientTerms.has(token));
  };
  const strings = collectStringValues(manifest.next_phase_recommendations);
  strings.push(...collectStringValues(manifest.blocker_summary));
  strings.push(...collectStringValues(manifest.verification_summary));
  return strings.every((text) => !unsafePattern.test(text) && !hasOutboundRecipientIntent(text));
}

function nextRecommendationsOk(manifest, contract = {}) {
  const expected = expectedShape(contract);
  const allowedTiers = asArray(expected.nextRecommendationAllowedTiers);
  const recommendations = asArray(manifest.next_phase_recommendations);
  return recommendations.length >= Number(expected.expectedCounts?.next_phase_recommendations_min || 0)
    && asArray(expected.nextRecommendationExpectedCandidates).every((candidate) => recommendations.some((recommendation) => (
      recommendation.recommendation_id === candidate.recommendation_id
        && recommendation.tier === candidate.tier
        && recommendation.title === candidate.title
        && recommendation.does_not_authorize_runtime === true
    )))
    && recommendations.every((recommendation) => hasRequiredFields(recommendation, expected.nextRecommendationRequiredFields || [])
      && allowedTiers.includes(recommendation.tier)
      && recommendation.does_not_authorize_runtime === true
      && asArray(recommendation.blocked_side_effects).length > 0
      && asArray(recommendation.prerequisites).length > 0
      && asArray(recommendation.evidenceRefs).length > 0);
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

function assertNoForbiddenOutput(value, extraForbidden = []) {
  const strings = collectStringValues(value);
  for (const forbidden of [...DEFAULT_FORBIDDEN_OUTPUT_SUBSTRINGS, ...extraForbidden]) {
    if (!forbidden) continue;
    const needle = String(forbidden).toLowerCase();
    if (strings.some((entry) => String(entry).toLowerCase().includes(needle))) {
      throw new Error(`runtime_milestone_refresh_forbidden_substring:${forbidden}`);
    }
  }
}

function validateManifest(manifest = {}, contract = {}) {
  const checks = [];
  const errors = [];
  const resultById = {};
  const add = (id, ok) => {
    const result = resultObject(id, ok);
    checks.push(result);
    resultById[id] = result;
    if (!ok) errors.push(id);
  };
  const expected = expectedShape(contract);

  const phaseOk = phaseInventoryOk(manifest, contract);
  const schemaOk = schemaRegistryOk(manifest, contract);
  const cliOk = cliRegistryOk(manifest, contract);
  const chainOk = commitChainOk(manifest, contract);
  const staleOk = staleReadinessOk(manifest);
  const closure30Ok = phase30ClosureOk(manifest);
  const runtimeOk = runtimeControlPathOk(manifest);
  const capabilityOk = capabilityTruthOk(manifest);
  const sideEffectsOk = sideEffectValuesOk(manifest.side_effect_result);
  const unsafeOk = unsafeActionPolicyOk(manifest, contract) && unsafeActionDriftOk(manifest);
  const recsOk = nextRecommendationsOk(manifest, contract);
  const blockersOk = blockerSummaryOk(manifest, contract);
  let forbiddenOk = true;
  try {
    assertNoForbiddenOutput(manifest, asArray(contract.forbiddenOutputSubstrings));
  } catch {
    forbiddenOk = false;
  }
  const idemOk = manifest.idempotency_key === runtimeMilestoneRefreshIdempotencyKey(manifest);
  const literalsOk = literalValuesOk(manifest, expected.requiredLiteralValues || {});
  const validationTruthOk = verificationTruthOk(manifest);
  const closure22Ok = phase22ClosureOk(manifest);

  add('output-shape-complete',
    manifest.schema === RUNTIME_MILESTONE_REFRESH_MANIFEST_SCHEMA_VERSION
      && hasRequiredFields(manifest, expected.requiredFields || REQUIRED_MANIFEST_FIELDS));
  add('baseline_679e018_pinned', manifest.baseline_commit === BASELINE_COMMIT);
  add('phase-inventory-exactly-30', phaseOk);
  add('phase_inventory_count_is_30', phaseOk);
  add('stale_phase_count_rejected', phaseOk);
  add('schema-registry-exactly-30', schemaOk);
  add('schema_registry_count_is_30', schemaOk);
  add('cli-registry-exactly-30', cliOk);
  add('cli_registry_count_is_30', cliOk);
  add('commit-chain-through-679e018', chainOk);
  add('commit_chain_count_is_18', chainOk);
  add('phase13-and-phase23-stale-superseded', staleOk);
  add('phase23_stale_superseded_by_phase31', staleOk);
  add('phase30-oracle-115-closure-carried-forward', closure30Ok);
  add('phase30_oracle_115_mapping_closure_present', closure30Ok);
  add('phase22-closure-carried-forward', closure22Ok);
  add('runtime-control-path-non-authorizing', runtimeOk);
  add('runtime_started_false', runtimeOk);
  add('runtime_available_now_false', runtimeOk);
  add('eligible_is_authorization_false', runtimeOk);
  add('capability-truth-preserved', capabilityOk);
  add('server_can_execute_local_false', capabilityOk);
  add('direct_builder_oracle_targets_blocked', capabilityOk);
  add('proof_boundaries_false', capabilityOk);
  add('side-effects-blocked-now', sideEffectsOk);
  add('side_effect_truth_all_blocked', sideEffectsOk);
  add('unsafe-action-drift-blocked', unsafeOk);
  add('unsafe_action_drift_rejected', unsafeOk);
  add('next-recommendations-tier0-tier1-only', recsOk);
  add('next_recommendations_tier0_tier1_only', recsOk);
  add('remaining-blockers-complete', blockersOk);
  add('no-raw-private-secret-output', forbiddenOk);
  add('no_raw_private_secret_content', forbiddenOk);
  add('idempotency-sensitive-to-registry-inputs', idemOk);
  add('validation-proof-honesty', validationTruthOk);
  add('manifest-literal-values', literalsOk);
  add('validation-report-matches-manifest',
    phaseOk && schemaOk && cliOk && chainOk && staleOk && closure30Ok && runtimeOk
      && capabilityOk && sideEffectsOk && unsafeOk && recsOk && blockersOk && forbiddenOk
      && idemOk && literalsOk && validationTruthOk && closure22Ok);

  return {
    ok: errors.length === 0,
    checks,
    errors,
    resultById,
  };
}

function buildValidationReport(manifest, contract = {}) {
  const validation = validateManifest(manifest, contract);
  const failed = validation.checks.filter((check) => !check.ok);
  const checkResult = (id) => validation.resultById[id] || resultObject(id, false);
  const report = {
    schema: VALIDATION_REPORT_SCHEMA_VERSION,
    version: RUNTIME_MILESTONE_REFRESH_VERSION,
    fixture_ref: 'ui/__tests__/fixtures/mira-core-runtime-milestone-refresh-contract.json',
    baseline_commit: BASELINE_COMMIT,
    accepted: validation.ok,
    decision: validation.ok ? 'accepted_validation_only' : 'rejected',
    reasons: failed.map((check) => check.id),
    checks: validation.checks,
    phase_inventory_count: asArray(manifest.phase_inventory).length,
    schema_registry_count: asArray(manifest.schema_registry).length,
    cli_registry_count: asArray(manifest.cli_registry).length,
    commit_chain_count: asArray(manifest.commit_chain).length,
    stale_readiness_result: checkResult('phase13-and-phase23-stale-superseded'),
    phase_30_closure_result: checkResult('phase30-oracle-115-closure-carried-forward'),
    capability_truth_result: checkResult('capability-truth-preserved'),
    unsafe_action_result: checkResult('unsafe-action-drift-blocked'),
    side_effect_result: sideEffectResult(),
    evidenceRefs: [
      evidenceRef('mira-core-runtime-milestone-refresh', 'phase31-validation-report'),
    ],
  };
  assertNoForbiddenOutput(report, asArray(contract.forbiddenOutputSubstrings));
  return report;
}

function buildMiraCoreRuntimeMilestoneRefresh(options = {}) {
  const contract = options.contract || {};
  const manifest = buildManifest(options);
  const validation_report = buildValidationReport(manifest, contract);
  const output = {
    runtime_milestone_refresh_manifest: manifest,
    validation_report,
  };
  assertNoForbiddenOutput(output, asArray(contract.forbiddenOutputSubstrings));
  return output;
}

function validateMiraCoreRuntimeMilestoneRefreshOutput(output = {}, contract = {}) {
  const checks = [];
  const errors = [];
  const add = (id, ok) => {
    checks.push({ id, ok: ok === true });
    if (!ok) errors.push(id);
  };
  const manifest = output.runtime_milestone_refresh_manifest || {};
  const report = output.validation_report || {};
  const manifestValidation = validateManifest(manifest, contract);

  add('output-shape-complete',
    hasRequiredFields(output, contract.expectedOutputShape?.requiredTopLevelFields || REQUIRED_OUTPUT_FIELDS)
      && manifest.schema === RUNTIME_MILESTONE_REFRESH_MANIFEST_SCHEMA_VERSION
      && report.schema === VALIDATION_REPORT_SCHEMA_VERSION
      && hasRequiredFields(manifest, contract.expectedRuntimeMilestoneRefreshManifestShape?.requiredFields || REQUIRED_MANIFEST_FIELDS)
      && hasRequiredFields(report, contract.expectedValidationReportShape?.requiredFields || REQUIRED_VALIDATION_REPORT_FIELDS));

  for (const check of manifestValidation.checks) add(check.id, check.ok);

  add('validation-report-literal-values',
    literalValuesOk(report, contract.expectedValidationReportShape?.requiredLiteralValues || {}));
  add('validation-report-side-effect-truth', sideEffectValuesOk(report.side_effect_result));
  add('validation-report-matches-manifest',
    report.accepted === manifestValidation.ok
      && report.decision === (manifestValidation.ok ? 'accepted_validation_only' : 'rejected')
      && report.phase_inventory_count === asArray(manifest.phase_inventory).length
      && report.schema_registry_count === asArray(manifest.schema_registry).length
      && report.cli_registry_count === asArray(manifest.cli_registry).length
      && report.commit_chain_count === asArray(manifest.commit_chain).length
      && idsEqual(asArray(report.checks), 'id', manifestValidation.checks.map((check) => check.id)));

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
  RUNTIME_MILESTONE_REFRESH_MANIFEST_SCHEMA_VERSION,
  VALIDATION_REPORT_SCHEMA_VERSION,
  assertNoForbiddenOutput,
  buildMiraCoreRuntimeMilestoneRefresh,
  runtimeMilestoneRefreshIdempotencyKey,
  stableHash,
  validateMiraCoreRuntimeMilestoneRefreshOutput,
};
