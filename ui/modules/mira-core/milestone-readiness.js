'use strict';

const crypto = require('crypto');

const MILESTONE_READINESS_MANIFEST_SCHEMA_VERSION = 'squidrun.mira_core.milestone_readiness_manifest.v0';
const VALIDATION_REPORT_SCHEMA_VERSION = 'squidrun.mira_core.milestone_readiness_validation_report.v0';
const MILESTONE_READINESS_VERSION = 'v0';
const BASELINE_COMMIT = 'b7e2106';

const REQUIRED_OUTPUT_FIELDS = Object.freeze([
  'milestone_readiness_manifest',
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
  'phase_22_closure',
  'artifact_summary',
  'verification_summary',
  'blocker_summary',
  'next_phase_recommendations',
  'evidenceRefs',
  'side_effect_result',
]);

const REQUIRED_VALIDATION_REPORT_FIELDS = Object.freeze([
  'schema',
  'version',
  'report_id',
  'generated_at',
  'baseline_commit',
  'decision',
  'reasons',
  'phase_inventory_count',
  'commit_chain_count',
  'schema_registry_count',
  'cli_registry_count',
  'phase_22_closure_result',
  'capability_truth_result',
  'side_effect_result',
  'acceptance_checks',
  'failed_checks',
  'evidenceRefs',
]);

const REQUIRED_SIDE_EFFECT_FIELDS = Object.freeze([
  'no_runtime_performed',
  'no_server_performed',
  'no_network_performed',
  'no_database_write_performed',
  'no_store_write_performed',
  'no_file_write_performed',
  'no_migration_executed',
  'no_queue_created',
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
  'networkRequestsAttempted',
  'databaseWritesAttempted',
  'storeWritesAttempted',
  'fileWritesAttempted',
  'migrationsAttempted',
  'queuesCreated',
  'authChangesAttempted',
  'keySecretOperationsAttempted',
  'localExecutionAttempted',
  'sendsAttempted',
  'deploysAttempted',
  'tradesAttempted',
  'outputFilesWritten',
]);

const CAPABILITY_TRUTH = Object.freeze({
  serverCanExecuteLocal: false,
  serverCanProveModelProcessing: false,
  realRuntimeAvailable: false,
  directBuilderOracleServerTargetsAllowed: false,
});

const REQUIRED_BLOCKER_IDS = Object.freeze([
  'real-runtime-still-blocked',
  'durable-memory-profile-commits-blocked',
  'server-persistence-network-blocked',
  'capture-execution-blocked',
  'phase13-readiness-stale-superseded',
]);

const REQUIRED_NEXT_RECOMMENDATION_IDS = Object.freeze([
  'phase23-implementation-validation-only',
  'phase24-runtime-gap-followup-spec-only',
]);

const DEFAULT_FORBIDDEN_OUTPUT_SUBSTRINGS = Object.freeze([
  'live server runtime present',
  'real runtime available',
  'server can execute local',
  'server can prove model processing',
  'direct builder target allowed',
  'direct oracle target allowed',
  'socket proves bridge green',
  'delivery acceptance proves model processing',
  'daemon started',
  'listener bound',
  'route registered',
  'network request performed',
  'database write performed',
  'store write performed',
  'file write performed',
  'queue created',
  'lease created',
  'local execution performed',
  'shell executed',
  'pty executed',
  'browser state captured',
  'screenshot captured',
  'ocr captured',
  'customer send performed',
  'deploy performed',
  'trade performed',
  'memory committed',
  'profile committed',
  'raw terminal scrollback',
  'raw browser state',
  'raw screenshot',
  'raw ocr',
  'raw customer private',
  'side-profile payload',
  'private key',
  'data key',
  'bearer token',
  'session secret',
  'plaintext payload',
  'ciphertext payload',
  'decrypted payload',
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
  return String(dottedPath || '').split('.').reduce((acc, key) => (acc && Object.prototype.hasOwnProperty.call(acc, key) ? acc[key] : undefined), value);
}

function valuesMatch(a, b) {
  return JSON.stringify(sortedValue(a)) === JSON.stringify(sortedValue(b));
}

function hasRequiredFields(value, fields = []) {
  return Boolean(value) && asArray(fields).every((field) => Object.prototype.hasOwnProperty.call(value, field));
}

function evidenceRef(store, eventId, relation = 'milestone_readiness_validation') {
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

function phaseInventory(contract = {}) {
  return asArray(contract.expectedMilestoneReadinessManifestShape?.phaseInventoryExpected).map((item) => ({
    ...clone(item),
    capability_truth: {
      ...CAPABILITY_TRUTH,
      localArmsProofSeparate: true,
    },
    evidenceRefs: [
      evidenceRef('mira-core-phase-registry', `phase:${item.phase}`),
    ],
  }));
}

function schemaRegistryFromInventory(inventory = []) {
  return asArray(inventory).map((item) => ({
    phase: item.phase,
    name: item.name,
    schema_ref: `squidrun.mira_core.${String(item.name).replace(/-/g, '_')}.v0`,
    fixture_path: item.fixture_path,
    module_path: item.module_path,
    test_path: item.test_path,
    committed_baseline: item.committed_baseline,
    evidenceRefs: [
      evidenceRef('mira-core-schema-registry', `phase:${item.phase}`),
    ],
  }));
}

function cliRegistryFromInventory(inventory = []) {
  return asArray(inventory).map((item) => ({
    phase: item.phase,
    name: item.name,
    cli_path: item.cli_path,
    stdout_only: true,
    output_file_mode: false,
    read_only_or_validation_only: true,
    evidenceRefs: [
      evidenceRef('mira-core-cli-registry', `phase:${item.phase}`),
    ],
  }));
}

function capabilityMatrix(contract = {}) {
  const expected = contract.expectedMilestoneReadinessManifestShape || {};
  return {
    serverCanExecuteLocal: false,
    serverCanProveModelProcessing: false,
    realRuntimeAvailable: false,
    directBuilderOracleServerTargetsAllowed: false,
    localArmsProofSeparate: true,
    allowedNowRiskTiers: clone(expected.allowedNowRiskTiers || ['tier0_read_only', 'tier1_local_reversible_validation']),
    blockedRiskTiers: clone(expected.blockedRiskTiers || [
      'tier2_repo_mutation_without_review',
      'tier3_external_side_effect',
      'tier4_financial_or_irreversible',
    ]),
    blockedCapabilities: [
      'runtime_daemon',
      'listener_route_transport',
      'durable_store_mutation',
      'queue_or_lease',
      'auth_key_secret_operation',
      'local_shell_pty_browser',
      'customer_message',
      'deployment',
      'financial_action',
      'memory_profile_durable_change',
    ],
  };
}

function boundaryTruth() {
  return {
    serverCanExecuteLocal: false,
    serverCanProveModelProcessing: false,
    realRuntimeAvailable: false,
    builderOracleDirectServerTargetsAllowed: false,
    socketIsBridgeGreenProof: false,
    deliveryAcceptanceIsModelProcessingProof: false,
    runtimeHarnessIsRealRuntimeProof: false,
    phase13ReadinessIsCurrentForPhases14Through22: false,
    localArmsProofSeparate: true,
    phase13Status: 'stale_superseded_by_phase23_rollup',
    phase22Status: 'validation_only_no_runtime_side_effects',
    evidenceRefs: [
      evidenceRef('mira-core-boundary-truth', 'phase23-boundary-truth'),
    ],
  };
}

function phase22Closure(contract = {}) {
  const expected = contract.expectedPhase22ClosureShape || {};
  return {
    phase: 22,
    baseline_commit: BASELINE_COMMIT,
    validation_only: true,
    no_daemon_listener_network_store_queue_lease_execution_output_file: true,
    oracle_review_refs: clone(expected.requiredReviewRefs || ['ORACLE #78', 'ORACLE #79', 'ORACLE #80']),
    closed_bypass_classes: clone(expected.requiredClosedBypassClasses || [
      'target_risk_raw_promotion_bypass',
      'replay_stale_tombstone_expired_relabel_move_bypass',
      'fact_removal_acceptance_bypass',
    ]),
    required_request_case_binding: clone(expected.requiredRequestCases || [
      'seq4_duplicate_replay_rejects_on_seq4',
      'seq5_stale_watermark_rejects_on_seq5',
      'seq6_tombstone_conflict_rejects_on_seq6',
      'seq7_expired_request_rejects_on_seq7',
    ]),
    direct_request_case_binding: true,
    same_sequence_decision_binding: true,
    recomputed_idempotency_regressions_present: true,
    oracle_78_79_bypasses_closed: true,
    evidenceRefs: [
      evidenceRef('mira-core-runtime-harness', 'phase22-oracle-78-79-80-closure'),
    ],
  };
}

function artifactSummary(inventory = [], schemaRegistry = [], cliRegistry = []) {
  return {
    phase_inventory_count: inventory.length,
    schema_registry_count: schemaRegistry.length,
    cli_registry_count: cliRegistry.length,
    fixture_count: inventory.filter((item) => item.fixture_path).length,
    module_count: inventory.filter((item) => item.module_path).length,
    test_count: inventory.filter((item) => item.test_path).length,
    stale_phase13_present: inventory.some((item) => item.phase === 13 && String(item.status).includes('superseded_by_phase_23')),
    phase22_closure_present: inventory.some((item) => item.phase === 22 && asArray(item.closure_refs).includes('ORACLE #80')),
    missing_artifacts: [],
    degraded_artifacts: [],
    evidenceRefs: [
      evidenceRef('mira-core-artifact-summary', 'phase23-artifact-summary'),
    ],
  };
}

function verificationSummary(inputSignals = {}) {
  const commands = asArray(inputSignals.verification?.commands);
  const proven = commands.length > 0 && commands.every((command) => command.result === 'PASS' && Number(command.failed_count || 0) === 0);
  return {
    no_fake_test_proof: true,
    proof_status: proven ? 'proven_by_reported_command' : 'unknown_without_phase23_command_input',
    reported_commands: clone(commands),
    prior_phase22_reported: {
      targeted: '29/29',
      combined: '365/365',
      source: 'builder_report_before_phase23',
    },
    unknown_or_degraded_proof: !proven,
    evidenceRefs: [
      evidenceRef('mira-core-verification-summary', 'phase23-verification-summary'),
    ],
  };
}

function blockerSummary() {
  const blockers = [
    ['real-runtime-still-blocked', 'Real runtime work stays behind transport, auth, durable state, replay, queue/lease, audit, schema, operator, monitoring, and recovery gates.'],
    ['durable-memory-profile-commits-blocked', 'Durable memory and profile changes remain proposal/validation surfaces, not committed state.'],
    ['server-persistence-network-blocked', 'Persistence and transport work remain blocked until the server path is explicitly delegated.'],
    ['capture-execution-blocked', 'Capture, apply, and local-arm execution stay unavailable without reviewed opt-in and proof gates.'],
    ['phase13-readiness-stale-superseded', 'Phase 13 indexed Phases 1-12 only and is superseded by this Phase 23 rollup.'],
  ];
  return blockers.map(([blockerId, blockedBecause]) => ({
    blocker_id: blockerId,
    severity: 'high',
    status: 'blocking_out_of_scope_behavior',
    blocked_because: blockedBecause,
    safe_next_action: 'Keep this milestone as read-only validation metadata.',
    evidenceRefs: [
      evidenceRef('mira-core-blocker-summary', blockerId),
    ],
  }));
}

function nextPhaseRecommendations() {
  return [
    {
      recommendation_id: 'phase23-implementation-validation-only',
      title: 'Finish Phase 23 milestone readiness validation',
      risk_tier: 'tier1_local_reversible_validation',
      why_safe: 'It validates registry metadata and emits stdout JSON only.',
      prerequisites: ['Oracle fixture accepted', 'Phase 22 commit b7e2106 present'],
      blocked_side_effects: ['runtime operations', 'transport operations', 'persistent mutations', 'local-arm actions', 'external actions'],
      evidenceRefs: [
        evidenceRef('mira-core-next-recommendation', 'phase23-implementation-validation-only'),
      ],
    },
    {
      recommendation_id: 'phase24-runtime-gap-followup-spec-only',
      title: 'Prepare Phase 24 gap contract as spec/validation only',
      risk_tier: 'tier0_read_only',
      why_safe: 'It remains contract planning and does not perform runtime behavior.',
      prerequisites: ['Phase 23 validation accepted'],
      blocked_side_effects: ['runtime operations', 'transport operations', 'store mutations', 'queue/lease operations', 'external actions'],
      evidenceRefs: [
        evidenceRef('mira-core-next-recommendation', 'phase24-runtime-gap-followup-spec-only'),
      ],
    },
  ];
}

function sideEffectResult() {
  return {
    no_runtime_performed: true,
    no_server_performed: true,
    no_network_performed: true,
    no_database_write_performed: true,
    no_store_write_performed: true,
    no_file_write_performed: true,
    no_migration_executed: true,
    no_queue_created: true,
    no_auth_change_performed: true,
    no_key_secret_operation_performed: true,
    no_local_execution_performed: true,
    no_send_performed: true,
    no_deploy_performed: true,
    no_trade_performed: true,
    no_output_file_written: true,
    runtimeAttempts: 0,
    serverAttempts: 0,
    networkRequestsAttempted: 0,
    databaseWritesAttempted: 0,
    storeWritesAttempted: 0,
    fileWritesAttempted: 0,
    migrationsAttempted: 0,
    queuesCreated: 0,
    authChangesAttempted: 0,
    keySecretOperationsAttempted: 0,
    localExecutionAttempted: 0,
    sendsAttempted: 0,
    deploysAttempted: 0,
    tradesAttempted: 0,
    outputFilesWritten: 0,
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
    phase_22_closure: manifest.phase_22_closure,
    artifact_summary: manifest.artifact_summary,
    blocker_summary: manifest.blocker_summary,
    next_phase_recommendations: manifest.next_phase_recommendations,
    side_effect_result: manifest.side_effect_result,
  };
}

function milestoneReadinessIdempotencyKey(manifest) {
  return `milestone-readiness-idem:${stableHash(canonicalManifestInput(manifest))}`;
}

function buildManifest(options = {}) {
  const contract = options.contract || {};
  const inputSignals = options.inputSignals || {};
  const scope = normalizeScope(inputSignals);
  const generatedAt = generatedAtFromOptions(options, inputSignals);
  const inventory = asArray(inputSignals.phase_inventory).length > 0
    ? clone(inputSignals.phase_inventory)
    : phaseInventory(contract);
  const schemaRegistry = asArray(inputSignals.schema_registry).length > 0
    ? clone(inputSignals.schema_registry)
    : schemaRegistryFromInventory(inventory);
  const cliRegistry = asArray(inputSignals.cli_registry).length > 0
    ? clone(inputSignals.cli_registry)
    : cliRegistryFromInventory(inventory);
  const manifest = {
    schema: MILESTONE_READINESS_MANIFEST_SCHEMA_VERSION,
    version: MILESTONE_READINESS_VERSION,
    manifest_id: null,
    idempotency_key: null,
    generated_at: generatedAt,
    profile: scope.profile,
    sessionId: scope.sessionId,
    deviceId: scope.deviceId,
    baseline_commit: BASELINE_COMMIT,
    phase_inventory: inventory,
    commit_chain: clone(inputSignals.commit_chain || contract.expectedMilestoneReadinessManifestShape?.commitChainExpected || []),
    schema_registry: schemaRegistry,
    cli_registry: cliRegistry,
    capability_matrix: capabilityMatrix(contract),
    boundary_truth: boundaryTruth(),
    phase_22_closure: phase22Closure(contract),
    artifact_summary: artifactSummary(inventory, schemaRegistry, cliRegistry),
    verification_summary: verificationSummary(inputSignals),
    blocker_summary: blockerSummary(),
    next_phase_recommendations: nextPhaseRecommendations(),
    evidenceRefs: [
      evidenceRef('mira-core-milestone-readiness', 'phase23-manifest'),
      evidenceRef('git', BASELINE_COMMIT, 'phase22_baseline_commit'),
    ],
    side_effect_result: sideEffectResult(),
  };
  manifest.idempotency_key = milestoneReadinessIdempotencyKey(manifest);
  manifest.manifest_id = `milestone-readiness-${stableHash(manifest.idempotency_key).slice(0, 12)}`;
  assertNoForbiddenOutput(manifest, asArray(contract.forbiddenOutputSubstrings));
  return manifest;
}

function resultObject(ok, detail = null, extra = {}) {
  return {
    ok: ok === true,
    detail,
    ...extra,
  };
}

function literalValuesOk(value, literals = {}) {
  return Object.entries(literals || {}).every(([field, expected]) => valuesMatch(pathValue(value, field), expected));
}

function sideEffectValuesOk(value = {}) {
  return REQUIRED_SIDE_EFFECT_FIELDS.every((field) => value[field] === true)
    && SIDE_EFFECT_COUNTER_FIELDS.every((field) => value[field] === undefined || Number(value[field]) === 0)
    && value.outputFileWritten !== true;
}

function phaseInventoryOk(manifest, contract = {}) {
  const expected = asArray(contract.expectedMilestoneReadinessManifestShape?.phaseInventoryExpected);
  const inventory = asArray(manifest.phase_inventory);
  const expectedFields = asArray(contract.expectedMilestoneReadinessManifestShape?.phaseInventoryRequiredFields);
  return expected.length === 22
    && inventory.length === 22
    && valuesMatch(inventory.map((item) => item.phase), Array.from({ length: 22 }, (_value, index) => index + 1))
    && expected.every((expectedItem) => {
      const item = inventory.find((entry) => entry.phase === expectedItem.phase);
      return item
        && hasRequiredFields(item, expectedFields)
        && Object.entries(expectedItem).every(([field, value]) => valuesMatch(item[field], value))
        && Object.entries(CAPABILITY_TRUTH).every(([field, value]) => item.capability_truth?.[field] === value)
        && item.capability_truth?.localArmsProofSeparate === true
        && asArray(item.evidenceRefs).length > 0;
    });
}

function commitChainOk(manifest, contract = {}) {
  return valuesMatch(manifest.commit_chain, contract.expectedMilestoneReadinessManifestShape?.commitChainExpected || []);
}

function registryOk(manifest) {
  const inventory = asArray(manifest.phase_inventory);
  const schemaRegistry = asArray(manifest.schema_registry);
  const cliRegistry = asArray(manifest.cli_registry);
  const phases = inventory.map((item) => item.phase);
  return schemaRegistry.length === 22
    && cliRegistry.length === 22
    && valuesMatch(schemaRegistry.map((item) => item.phase), phases)
    && valuesMatch(cliRegistry.map((item) => item.phase), phases)
    && schemaRegistry.every((entry) => {
      const inventoryItem = inventory.find((item) => item.phase === entry.phase);
      return inventoryItem
        && entry.fixture_path === inventoryItem.fixture_path
        && entry.module_path === inventoryItem.module_path
        && entry.test_path === inventoryItem.test_path
        && asArray(entry.evidenceRefs).length > 0;
    })
    && cliRegistry.every((entry) => {
      const inventoryItem = inventory.find((item) => item.phase === entry.phase);
      return inventoryItem
        && entry.cli_path === inventoryItem.cli_path
        && entry.stdout_only === true
        && entry.output_file_mode === false
        && entry.read_only_or_validation_only === true
        && asArray(entry.evidenceRefs).length > 0;
    });
}

function phase13SupersededOk(manifest) {
  const phase13 = asArray(manifest.phase_inventory).find((item) => item.phase === 13);
  return phase13?.status === 'stale_local_readiness_runtime_present_superseded_by_phase_23'
    && manifest.boundary_truth?.phase13ReadinessIsCurrentForPhases14Through22 === false
    && manifest.artifact_summary?.stale_phase13_present === true;
}

function phase22ClosureOk(manifest, contract = {}) {
  const closure = manifest.phase_22_closure || {};
  const expected = contract.expectedPhase22ClosureShape || {};
  const phase22 = asArray(manifest.phase_inventory).find((item) => item.phase === 22);
  return hasRequiredFields(closure, expected.requiredFields || [])
    && literalValuesOk(closure, expected.requiredLiteralValues || {})
    && asArray(expected.requiredReviewRefs).every((ref) => asArray(closure.oracle_review_refs).includes(ref))
    && asArray(expected.requiredClosedBypassClasses).every((id) => asArray(closure.closed_bypass_classes).includes(id))
    && asArray(expected.requiredRequestCases).every((id) => asArray(closure.required_request_case_binding).includes(id))
    && phase22?.validation_only === true
    && phase22?.committed_baseline === BASELINE_COMMIT
    && asArray(phase22?.closure_refs).includes('ORACLE #78')
    && asArray(phase22?.closure_refs).includes('ORACLE #79')
    && asArray(phase22?.closure_refs).includes('ORACLE #80')
    && asArray(closure.evidenceRefs).length > 0;
}

function capabilityTruthOk(manifest, contract = {}) {
  const expected = contract.expectedMilestoneReadinessManifestShape || {};
  return hasRequiredFields(manifest.capability_matrix, expected.capabilityMatrixRequiredFields || [])
    && Object.entries(expected.capabilityMatrixRequiredValues || {}).every(([field, value]) => manifest.capability_matrix?.[field] === value)
    && valuesMatch(manifest.capability_matrix?.allowedNowRiskTiers, expected.allowedNowRiskTiers || [])
    && valuesMatch(manifest.capability_matrix?.blockedRiskTiers, expected.blockedRiskTiers || [])
    && manifest.boundary_truth?.serverCanExecuteLocal === false
    && manifest.boundary_truth?.serverCanProveModelProcessing === false
    && manifest.boundary_truth?.realRuntimeAvailable === false
    && manifest.boundary_truth?.builderOracleDirectServerTargetsAllowed === false
    && manifest.boundary_truth?.socketIsBridgeGreenProof === false
    && manifest.boundary_truth?.deliveryAcceptanceIsModelProcessingProof === false
    && manifest.boundary_truth?.runtimeHarnessIsRealRuntimeProof === false
    && manifest.boundary_truth?.phase13ReadinessIsCurrentForPhases14Through22 === false
    && manifest.boundary_truth?.localArmsProofSeparate === true;
}

function blockerSummaryOk(manifest, contract = {}) {
  const required = asArray(contract.expectedMilestoneReadinessManifestShape?.requiredBlockerIds).length > 0
    ? contract.expectedMilestoneReadinessManifestShape.requiredBlockerIds
    : REQUIRED_BLOCKER_IDS;
  const blockers = asArray(manifest.blocker_summary);
  return required.every((id) => blockers.some((blocker) => blocker.blocker_id === id
    && blocker.status
    && blocker.blocked_because
    && blocker.safe_next_action
    && asArray(blocker.evidenceRefs).length > 0));
}

function nextRecommendationsOk(manifest, contract = {}) {
  const expected = contract.expectedMilestoneReadinessManifestShape || {};
  const required = asArray(expected.requiredNextRecommendationIds).length > 0
    ? expected.requiredNextRecommendationIds
    : REQUIRED_NEXT_RECOMMENDATION_IDS;
  const allowedTiers = asArray(expected.allowedNextRecommendationRiskTiers).length > 0
    ? expected.allowedNextRecommendationRiskTiers
    : ['tier0_read_only', 'tier1_local_reversible_validation'];
  const recommendations = asArray(manifest.next_phase_recommendations);
  return required.every((id) => recommendations.some((recommendation) => recommendation.recommendation_id === id))
    && recommendations.every((recommendation) => hasRequiredFields(recommendation, expected.nextRecommendationRequiredFields || [])
      && allowedTiers.includes(recommendation.risk_tier)
      && recommendation.why_safe
      && asArray(recommendation.prerequisites).length > 0
      && asArray(recommendation.blocked_side_effects).length > 0
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
    if (strings.some((entry) => entry.includes(forbidden))) {
      throw new Error(`milestone_readiness_forbidden_substring:${forbidden}`);
    }
  }
}

function validateManifest(manifest = {}, contract = {}) {
  const checks = [];
  const errors = [];
  const resultById = {};
  const add = (id, ok, detail = null, extra = {}) => {
    const result = resultObject(ok, detail, { id, ...extra });
    checks.push(result);
    resultById[id] = result;
    if (!ok && detail) errors.push(detail);
  };
  const expected = contract.expectedMilestoneReadinessManifestShape || {};

  add('output-shape-complete',
    manifest.schema === MILESTONE_READINESS_MANIFEST_SCHEMA_VERSION
      && hasRequiredFields(manifest, expected.requiredFields || REQUIRED_MANIFEST_FIELDS),
    'Milestone readiness manifest shape is incomplete.');

  add('baseline-b7e2106-pinned',
    manifest.baseline_commit === BASELINE_COMMIT,
    'Baseline commit must stay pinned to b7e2106.');

  add('phase-inventory-exactly-1-through-22',
    asArray(manifest.phase_inventory).length === 22
      && valuesMatch(asArray(manifest.phase_inventory).map((item) => item.phase), Array.from({ length: 22 }, (_value, index) => index + 1)),
    'Phase inventory must contain exactly Phases 1-22 in order.');

  add('phase-paths-and-commits-match-registry',
    phaseInventoryOk(manifest, contract),
    'Phase paths, commits, or registry truth drifted.');

  add('commit-chain-complete-and-ordered',
    commitChainOk(manifest, contract),
    'Commit chain is incomplete or out of order.');

  add('schema-cli-registry-complete',
    registryOk(manifest),
    'Schema or CLI registry is incomplete.');

  add('phase13-stale-superseded-by-phase23',
    phase13SupersededOk(manifest),
    'Phase 13 readiness stale/superseded truth is missing.');

  add('phase22-validation-only-closures-recorded',
    phase22ClosureOk(manifest, contract),
    'Phase 22 validation-only closure record is incomplete.');

  add('capability-matrix-no-runtime-overclaim',
    capabilityTruthOk(manifest, contract),
    'Capability matrix or boundary truth overclaimed runtime/proof/target authority.');

  add('blocker-summary-complete',
    blockerSummaryOk(manifest, contract),
    'Required milestone blockers are missing.');

  add('next-recommendations-tier0-tier1-only',
    nextRecommendationsOk(manifest, contract),
    'Next recommendations are missing or too risky.');

  add('verification-proof-honesty',
    verificationTruthOk(manifest),
    'Verification proof was promoted without command/result evidence.');

  add('side-effect-truth-all-safe',
    sideEffectValuesOk(manifest.side_effect_result),
    'Milestone readiness side-effect truth is unsafe.');

  try {
    assertNoForbiddenOutput(manifest, asArray(contract.forbiddenOutputSubstrings));
    add('forbidden-raw-private-content-absent', true, null);
  } catch (err) {
    add('forbidden-raw-private-content-absent', false, err.message);
  }

  add('manifest-literal-values',
    literalValuesOk(manifest, expected.requiredLiteralValues || {}),
    'Manifest literal values changed.');

  add('idempotency-sensitive-to-inventory-and-commit-chain',
    manifest.idempotency_key === milestoneReadinessIdempotencyKey(manifest),
    'Milestone readiness idempotency key is unstable.');

  return {
    ok: errors.length === 0,
    checks,
    errors,
    resultById,
  };
}

function buildValidationReport(manifest, contract = {}, generatedAt = manifest.generated_at) {
  const validation = validateManifest(manifest, contract);
  const failed = validation.checks.filter((check) => !check.ok);
  const report = {
    schema: VALIDATION_REPORT_SCHEMA_VERSION,
    version: MILESTONE_READINESS_VERSION,
    report_id: `milestone-readiness-validation-${stableHash({
      manifest_key: manifest.idempotency_key,
      generatedAt,
    }).slice(0, 12)}`,
    generated_at: generatedAt,
    baseline_commit: BASELINE_COMMIT,
    decision: validation.ok ? 'accepted' : 'blocked',
    reasons: failed.map((check) => check.detail || check.id),
    phase_inventory_count: asArray(manifest.phase_inventory).length,
    commit_chain_count: asArray(manifest.commit_chain).length,
    schema_registry_count: asArray(manifest.schema_registry).length,
    cli_registry_count: asArray(manifest.cli_registry).length,
    phase_22_closure_result: validation.resultById['phase22-validation-only-closures-recorded'] || resultObject(false, 'phase22 closure check missing'),
    capability_truth_result: validation.resultById['capability-matrix-no-runtime-overclaim'] || resultObject(false, 'capability check missing'),
    side_effect_result: sideEffectResult(),
    acceptance_checks: asArray(contract.acceptanceChecks).map((check) => ({
      id: check.id,
      ok: validation.ok,
      focus: check.focus,
    })),
    failed_checks: failed.map((check) => check.id),
    evidenceRefs: [
      evidenceRef('mira-core-milestone-readiness', 'phase23-validation-report'),
    ],
  };
  assertNoForbiddenOutput(report, asArray(contract.forbiddenOutputSubstrings));
  return report;
}

function buildMiraCoreMilestoneReadiness(options = {}) {
  const contract = options.contract || {};
  const manifest = buildManifest(options);
  const validation_report = buildValidationReport(manifest, contract, manifest.generated_at);
  const output = {
    milestone_readiness_manifest: manifest,
    validation_report,
  };
  assertNoForbiddenOutput(output, asArray(contract.forbiddenOutputSubstrings));
  return output;
}

function validateMiraCoreMilestoneReadinessOutput(output = {}, contract = {}) {
  const checks = [];
  const errors = [];
  const add = (id, ok, detail = null) => {
    checks.push({ id, ok: ok === true, detail });
    if (!ok && detail) errors.push(detail);
  };
  const manifest = output.milestone_readiness_manifest || {};
  const report = output.validation_report || {};
  const manifestValidation = validateManifest(manifest, contract);

  add('output-shape-complete',
    hasRequiredFields(output, contract.expectedOutputShape?.requiredTopLevelFields || REQUIRED_OUTPUT_FIELDS)
      && manifest.schema === MILESTONE_READINESS_MANIFEST_SCHEMA_VERSION
      && report.schema === VALIDATION_REPORT_SCHEMA_VERSION
      && hasRequiredFields(manifest, contract.expectedMilestoneReadinessManifestShape?.requiredFields || REQUIRED_MANIFEST_FIELDS)
      && hasRequiredFields(report, contract.expectedValidationReportShape?.requiredFields || REQUIRED_VALIDATION_REPORT_FIELDS),
    'Milestone readiness output shape is incomplete.');

  for (const check of manifestValidation.checks) add(check.id, check.ok, check.detail);

  add('validation-report-literal-values',
    literalValuesOk(report, contract.expectedValidationReportShape?.requiredLiteralValues || {}),
    'Validation report literal values changed.');

  add('validation-report-side-effect-truth',
    sideEffectValuesOk(report.side_effect_result),
    'Validation report side-effect truth is unsafe.');

  try {
    assertNoForbiddenOutput(output, asArray(contract.forbiddenOutputSubstrings));
    add('forbidden-output-strings-absent', true, null);
  } catch (err) {
    add('forbidden-output-strings-absent', false, err.message);
  }

  return {
    ok: errors.length === 0,
    checks,
    errors,
  };
}

module.exports = {
  BASELINE_COMMIT,
  MILESTONE_READINESS_MANIFEST_SCHEMA_VERSION,
  REQUIRED_BLOCKER_IDS,
  REQUIRED_MANIFEST_FIELDS,
  REQUIRED_NEXT_RECOMMENDATION_IDS,
  REQUIRED_OUTPUT_FIELDS,
  REQUIRED_VALIDATION_REPORT_FIELDS,
  VALIDATION_REPORT_SCHEMA_VERSION,
  assertNoForbiddenOutput,
  buildMiraCoreMilestoneReadiness,
  milestoneReadinessIdempotencyKey,
  stableHash,
  validateMiraCoreMilestoneReadinessOutput,
};
