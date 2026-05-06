'use strict';

const crypto = require('crypto');

const RUNTIME_PROMOTION_GATE_REPORT_SCHEMA_VERSION = 'squidrun.mira_core.runtime_promotion_gate_report.v0';
const VALIDATION_REPORT_SCHEMA_VERSION = 'squidrun.mira_core.runtime_promotion_gate_validation_report.v0';
const RUNTIME_PROMOTION_GATE_VERSION = 'v0';
const BASELINE_COMMIT = '3ce041c';

const REQUIRED_OUTPUT_FIELDS = Object.freeze([
  'runtime_promotion_gate_report',
  'validation_report',
]);

const REQUIRED_REPORT_FIELDS = Object.freeze([
  'schema',
  'version',
  'gate_report_id',
  'idempotency_key',
  'generated_at',
  'profile',
  'sessionId',
  'deviceId',
  'baseline_commit',
  'phase_23_dependency',
  'operator_promotion_decision',
  'required_prerequisite_gates',
  'side_effect_gates',
  'proof_boundaries',
  'replay_safety_gates',
  'environment_config_gates',
  'future_runtime_slice_limits',
  'tamper_case_coverage',
  'blocker_summary',
  'next_safe_actions',
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
  'promotion_decision_result',
  'phase_23_dependency_result',
  'prerequisite_gate_result',
  'side_effect_gate_result',
  'proof_boundary_result',
  'replay_safety_result',
  'environment_config_result',
  'acceptance_checks',
  'failed_checks',
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

const ALLOWED_PROMOTION_DECISIONS = Object.freeze([
  'remain_validation_only',
  'blocked',
  'eligible_for_future_runtime_slice',
]);

const ALLOWED_PROMOTION_RISK_TIERS = Object.freeze([
  'tier0_read_only',
  'tier1_local_reversible_validation',
]);

const DEFAULT_PREREQUISITE_GATE_IDS = Object.freeze([
  'explicit-runtime-mode-flag',
  'local-only-dev-binding',
  'operator-kill-switch',
  'dry-run-fallback',
  'phase15-identity-signing-ref',
  'phase16-auth-binding-ref',
  'phase17-storage-retention-boundary-ref',
  'phase18-persistence-audit-boundary-ref',
  'phase19-encryption-key-ref',
  'phase20-server-api-ref',
  'phase21-server-handler-ref',
  'phase22-runtime-harness-ref',
  'phase23-milestone-readiness-current',
]);

const DEFAULT_SIDE_EFFECT_GATE_IDS = Object.freeze([
  'no-real-runtime-now',
  'no-server-listener-route-now',
  'no-network-now',
  'no-db-store-file-migration-now',
  'no-queue-lease-now',
  'no-auth-key-secret-now',
  'no-local-execution-now',
  'no-send-deploy-trade-now',
  'no-output-file-now',
]);

const DEFAULT_ENVIRONMENT_GATE_IDS = Object.freeze([
  'port-binding-plan-ref',
  'auth-secret-presence-ref',
  'storage-path-ref',
  'migration-plan-ref',
  'telemetry-audit-plan-ref',
  'rollback-disable-plan-ref',
]);

const DEFAULT_BLOCKER_IDS = Object.freeze([
  'runtime-promotion-remains-validation-only',
  'kill-switch-required-before-runtime',
  'rollback-disable-required-before-runtime',
  'audit-telemetry-required-before-runtime',
  'storage-network-runtime-blocked-now',
  'local-execution-and-direct-targets-blocked',
]);

const DEFAULT_NEXT_SAFE_ACTION_IDS = Object.freeze([
  'implement-phase24-validator-only',
  'prepare-future-runtime-slice-spec-after-green',
]);

const DEFAULT_TAMPER_CASE_IDS = Object.freeze([
  'tamper-eligible-with-missing-kill-switch',
  'tamper-hidden-listener-network-store',
  'tamper-tier3-promotion',
  'tamper-raw-secret-leak',
  'tamper-fake-proof',
  'tamper-phase22-closure-missing',
  'tamper-phase23-stale',
]);

const DEFAULT_FORBIDDEN_OUTPUT_SUBSTRINGS = Object.freeze([
  'runtime started',
  'daemon started',
  'server started',
  'listener bound',
  'route registered',
  'http server listening',
  'websocket listening',
  'network request performed',
  'database write performed',
  'store write performed',
  'file write performed',
  'migration executed',
  'queue created',
  'lease created',
  'auth changed',
  'key generated',
  'secret read',
  'local execution performed',
  'shell executed',
  'pty executed',
  'browser state captured',
  'screenshot captured',
  'ocr captured',
  'customer send performed',
  'external send performed',
  'deploy performed',
  'trade performed',
  'output file written',
  'socket proves bridge green',
  'delivery acceptance proves model processing',
  'server can execute local arms',
  'direct builder target allowed',
  'direct oracle target allowed',
  'eligible authorizes runtime',
  'tier3 promoted',
  'tier4 promoted',
  'raw terminal scrollback',
  'raw browser state',
  'raw screenshot',
  'raw ocr',
  'raw customer private',
  'side-profile payload',
  'source-store payload',
  'bearer token',
  'session secret',
  'auth secret value',
  'private key',
  'data key',
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

function evidenceRef(store, eventId, relation = 'runtime_promotion_gate_validation') {
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

function phase23Dependency() {
  return {
    dependency_id: 'phase_23_milestone_readiness',
    fixture_path: 'ui/__tests__/fixtures/mira-core-milestone-readiness-contract.json',
    module_path: 'ui/modules/mira-core/milestone-readiness.js',
    cli_path: 'ui/scripts/hm-mira-core-milestone-readiness.js',
    test_path: 'ui/__tests__/mira-core-milestone-readiness.test.js',
    baseline_commit: BASELINE_COMMIT,
    status: 'current_read_only_rollup_green',
    current_through_phase: 22,
    phase_inventory_count: 22,
    commit_chain_count: 10,
    phase_13_stale_superseded: true,
    phase_22_closure_required: true,
    capability_truth_ref: 'phase23:serverCanExecuteLocal=false;serverCanProveModelProcessing=false;realRuntimeAvailable=false',
    evidenceRefs: [
      evidenceRef('mira-core-milestone-readiness', 'phase23-dependency-current'),
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
    outputFileWritten: false,
  };
}

function prerequisiteGateIds(contract = {}) {
  return asArray(contract.expectedRuntimePromotionGateReportShape?.requiredPrerequisiteGateIds).length > 0
    ? contract.expectedRuntimePromotionGateReportShape.requiredPrerequisiteGateIds
    : DEFAULT_PREREQUISITE_GATE_IDS;
}

function prerequisiteGates(contract = {}, inputSignals = {}) {
  const refs = contract.expectedRuntimePromotionGateReportShape?.requiredPrerequisiteGateRefs || {};
  const satisfied = new Set(asArray(inputSignals.satisfiedPrerequisiteGates));
  const allSatisfied = inputSignals.allPrerequisitesSatisfied === true;
  return prerequisiteGateIds(contract).map((gateId) => {
    const isSatisfied = allSatisfied || satisfied.has(gateId);
    return {
      gate_id: gateId,
      title: gateId.replace(/-/g, ' '),
      status: isSatisfied ? 'satisfied_by_reference' : 'represented_reference_only_not_satisfied',
      required_for_future_eligibility: true,
      reference_only: true,
      phase_refs: refs[gateId] ? [refs[gateId]] : [`phase24:${gateId}:future-reference-required`],
      must_be_operator_visible: true,
      blocks_if_missing: true,
      evidenceRefs: [
        evidenceRef('mira-core-runtime-promotion-gate', `prerequisite:${gateId}`),
      ],
    };
  });
}

function sideEffectGates(contract = {}) {
  const ids = asArray(contract.expectedRuntimePromotionGateReportShape?.requiredSideEffectGateIds).length > 0
    ? contract.expectedRuntimePromotionGateReportShape.requiredSideEffectGateIds
    : DEFAULT_SIDE_EFFECT_GATE_IDS;
  return ids.map((gateId) => ({
    gate_id: gateId,
    must_remain_false_now: true,
    counter_field: counterFieldForSideEffectGate(gateId),
    blocked_behavior: gateId,
    failure_decision: 'blocked',
    evidenceRefs: [
      evidenceRef('mira-core-runtime-promotion-gate', `side-effect:${gateId}`),
    ],
  }));
}

function counterFieldForSideEffectGate(gateId) {
  const fields = {
    'no-real-runtime-now': 'runtimeAttempts',
    'no-server-listener-route-now': 'listenerRouteAttempts',
    'no-network-now': 'networkRequestsAttempted',
    'no-db-store-file-migration-now': 'databaseWritesAttempted',
    'no-queue-lease-now': 'queuesCreated',
    'no-auth-key-secret-now': 'authChangesAttempted',
    'no-local-execution-now': 'localExecutionAttempted',
    'no-send-deploy-trade-now': 'sendsAttempted',
    'no-output-file-now': 'outputFilesWritten',
  };
  return fields[gateId] || 'runtimeAttempts';
}

function proofBoundaries() {
  return {
    socket_is_bridge_green_proof: false,
    delivery_acceptance_is_model_processing_proof: false,
    server_can_execute_local_arms: false,
    builder_direct_server_target_allowed: false,
    oracle_direct_server_target_allowed: false,
    runtime_gate_is_runtime_proof: false,
    evidenceRefs: [
      evidenceRef('mira-core-runtime-promotion-gate', 'proof-boundaries'),
    ],
  };
}

function replaySafetyGates() {
  return {
    phase_22_oracle_78_79_80_closure_required: true,
    idempotency_gate: 'required',
    replay_gate: 'required',
    tombstone_gate: 'required',
    watermark_gate: 'required',
    expiry_gate: 'required',
    same_sequence_decision_binding_required: true,
    recomputed_idempotency_regressions_required: true,
    evidenceRefs: [
      evidenceRef('mira-core-runtime-harness', 'phase22-oracle-78-79-80-closure'),
    ],
  };
}

function environmentConfigGates(contract = {}, inputSignals = {}) {
  const ids = asArray(contract.expectedRuntimePromotionGateReportShape?.requiredEnvironmentConfigGateIds).length > 0
    ? contract.expectedRuntimePromotionGateReportShape.requiredEnvironmentConfigGateIds
    : DEFAULT_ENVIRONMENT_GATE_IDS;
  const satisfied = new Set(asArray(inputSignals.satisfiedEnvironmentGates));
  const allSatisfied = inputSignals.allEnvironmentGatesSatisfied === true;
  return ids.map((gateId) => {
    const isSatisfied = allSatisfied || satisfied.has(gateId);
    return {
      gate_id: gateId,
      future_only: true,
      reference_only: true,
      status: isSatisfied ? 'satisfied_by_reference' : 'future_reference_required',
      raw_secret_allowed: false,
      raw_path_allowed: false,
      blocks_eligibility_if_missing: true,
      evidenceRefs: [
        evidenceRef('mira-core-runtime-promotion-gate', `environment:${gateId}`),
      ],
    };
  });
}

function futureRuntimeSliceLimits() {
  return {
    future_only: true,
    eligible_is_authorization: false,
    allowed_risk_tiers: clone(ALLOWED_PROMOTION_RISK_TIERS),
    blocked_action_classes: [
      'repo_mutation_without_review',
      'external_side_effect',
      'financial_or_irreversible',
      'customer_message',
      'deployment',
      'local_execution',
    ],
    max_scope: 'future_local_only_dev_slice_after_explicit_delegation',
    evidenceRefs: [
      evidenceRef('mira-core-runtime-promotion-gate', 'future-runtime-slice-limits'),
    ],
  };
}

function tamperCaseCoverage(contract = {}) {
  const fixtureCases = asArray(contract.tamperCases);
  const ids = fixtureCases.length > 0 ? fixtureCases.map((item) => item.id) : DEFAULT_TAMPER_CASE_IDS;
  return ids.map((caseId) => ({
    tamper_case_id: caseId,
    covered: true,
    expected_failure_checks: clone(fixtureCases.find((item) => item.id === caseId)?.expected_failure_checks || []),
    evidenceRefs: [
      evidenceRef('mira-core-runtime-promotion-gate-tests', caseId),
    ],
  }));
}

function blockerSummary(contract = {}) {
  const ids = asArray(contract.expectedRuntimePromotionGateReportShape?.blockerSummaryRequiredIds).length > 0
    ? contract.expectedRuntimePromotionGateReportShape.blockerSummaryRequiredIds
    : DEFAULT_BLOCKER_IDS;
  return ids.map((blockerId) => ({
    blocker_id: blockerId,
    severity: 'high',
    status: 'blocking_runtime_promotion',
    blocked_because: 'Future runtime gates are validation references only in Phase 24.',
    safe_next_action: 'Keep promotion gate as read-only validation metadata.',
    evidenceRefs: [
      evidenceRef('mira-core-runtime-promotion-gate', `blocker:${blockerId}`),
    ],
  }));
}

function nextSafeActions(contract = {}) {
  const ids = asArray(contract.expectedRuntimePromotionGateReportShape?.nextSafeActionRequiredIds).length > 0
    ? contract.expectedRuntimePromotionGateReportShape.nextSafeActionRequiredIds
    : DEFAULT_NEXT_SAFE_ACTION_IDS;
  const titles = {
    'implement-phase24-validator-only': 'Finish Phase 24 validator only',
    'prepare-future-runtime-slice-spec-after-green': 'Prepare a future runtime slice spec after green review',
  };
  return ids.map((actionId) => ({
    action_id: actionId,
    title: titles[actionId] || actionId.replace(/-/g, ' '),
    risk_tier: actionId.includes('spec') ? 'tier0_read_only' : 'tier1_local_reversible_validation',
    allowed: true,
    why_safe: 'This remains validation/spec work and does not perform runtime behavior.',
    blocked_side_effects: [
      'runtime',
      'network',
      'storage',
      'queue_or_lease',
      'auth_key_secret',
      'local_execution',
      'send_deploy_trade',
      'output_artifact',
    ],
    evidenceRefs: [
      evidenceRef('mira-core-runtime-promotion-gate', `next:${actionId}`),
    ],
  }));
}

function allPrerequisitesSatisfied(gates = []) {
  return asArray(gates).every((gate) => gate.status === 'satisfied_by_reference'
    && gate.reference_only === true
    && gate.required_for_future_eligibility === true
    && gate.blocks_if_missing === true
    && asArray(gate.phase_refs).length > 0);
}

function allEnvironmentGatesSatisfied(gates = []) {
  return asArray(gates).every((gate) => gate.future_only === true
    && gate.reference_only === true
    && gate.status === 'satisfied_by_reference'
    && gate.raw_secret_allowed === false
    && gate.raw_path_allowed === false
    && gate.blocks_eligibility_if_missing === true);
}

function operatorPromotionDecision(prerequisites = [], environmentGates = [], inputSignals = {}, contract = {}) {
  const requestedDecision = inputSignals.operatorDecision || 'remain_validation_only';
  const allowedDecisions = contract.expectedRuntimePromotionGateReportShape?.allowedPromotionDecisions || ALLOWED_PROMOTION_DECISIONS;
  const riskTier = inputSignals.riskTier || 'tier1_local_reversible_validation';
  const prerequisiteOk = allPrerequisitesSatisfied(prerequisites);
  const environmentOk = allEnvironmentGatesSatisfied(environmentGates);
  const eligibleRequested = requestedDecision === 'eligible_for_future_runtime_slice';
  const decision = allowedDecisions.includes(requestedDecision) ? requestedDecision : 'blocked';
  const missingGates = prerequisites
    .filter((gate) => gate.status !== 'satisfied_by_reference')
    .map((gate) => gate.gate_id)
    .concat(environmentGates.filter((gate) => gate.status !== 'satisfied_by_reference').map((gate) => gate.gate_id));
  return {
    decision: eligibleRequested && (!prerequisiteOk || !environmentOk) ? 'blocked' : decision,
    allowed_decisions: clone(allowedDecisions),
    default_decision: 'remain_validation_only',
    decision_reason: eligibleRequested && prerequisiteOk && environmentOk
      ? 'Eligible for a future explicitly delegated slice only; no runtime behavior is authorized here.'
      : 'Remain validation-only until future runtime gates are satisfied by references and reviewed.',
    risk_tier: riskTier,
    operator_visible: true,
    runtime_started: false,
    eligible_decision_is_authorization: false,
    missing_gates: missingGates,
    satisfied_gates: prerequisites.filter((gate) => gate.status === 'satisfied_by_reference').map((gate) => gate.gate_id),
    blocked_side_effects: [
      'runtime',
      'server_listener_route',
      'network',
      'database_store_file_migration',
      'queue_lease',
      'auth_key_secret',
      'local_execution',
      'send_deploy_trade',
      'output_file',
    ],
    safe_next_action: 'Keep Phase 24 as an operator-visible validation gate report.',
    evidenceRefs: [
      evidenceRef('mira-core-runtime-promotion-gate', 'operator-promotion-decision'),
    ],
  };
}

function canonicalGateReportInput(report) {
  return {
    baseline_commit: report.baseline_commit,
    profile: report.profile,
    sessionId: report.sessionId,
    deviceId: report.deviceId,
    phase_23_dependency: report.phase_23_dependency,
    operator_promotion_decision: report.operator_promotion_decision,
    required_prerequisite_gates: report.required_prerequisite_gates,
    side_effect_gates: report.side_effect_gates,
    proof_boundaries: report.proof_boundaries,
    replay_safety_gates: report.replay_safety_gates,
    environment_config_gates: report.environment_config_gates,
    future_runtime_slice_limits: report.future_runtime_slice_limits,
    tamper_case_coverage: report.tamper_case_coverage,
    blocker_summary: report.blocker_summary,
    next_safe_actions: report.next_safe_actions,
    side_effect_result: report.side_effect_result,
  };
}

function runtimePromotionGateIdempotencyKey(report) {
  return `runtime-promotion-gate-idem:${stableHash(canonicalGateReportInput(report))}`;
}

function buildGateReport(options = {}) {
  const contract = options.contract || {};
  const inputSignals = options.inputSignals || {};
  const scope = normalizeScope(inputSignals);
  const generatedAt = generatedAtFromOptions(options, inputSignals);
  const prereqs = prerequisiteGates(contract, inputSignals);
  const envGates = environmentConfigGates(contract, inputSignals);
  const report = {
    schema: RUNTIME_PROMOTION_GATE_REPORT_SCHEMA_VERSION,
    version: RUNTIME_PROMOTION_GATE_VERSION,
    gate_report_id: null,
    idempotency_key: null,
    generated_at: generatedAt,
    profile: scope.profile,
    sessionId: scope.sessionId,
    deviceId: scope.deviceId,
    baseline_commit: BASELINE_COMMIT,
    phase_23_dependency: phase23Dependency(),
    operator_promotion_decision: operatorPromotionDecision(prereqs, envGates, inputSignals, contract),
    required_prerequisite_gates: prereqs,
    side_effect_gates: sideEffectGates(contract),
    proof_boundaries: proofBoundaries(),
    replay_safety_gates: replaySafetyGates(),
    environment_config_gates: envGates,
    future_runtime_slice_limits: futureRuntimeSliceLimits(),
    tamper_case_coverage: tamperCaseCoverage(contract),
    blocker_summary: blockerSummary(contract),
    next_safe_actions: nextSafeActions(contract),
    evidenceRefs: [
      evidenceRef('mira-core-runtime-promotion-gate', 'phase24-report'),
      evidenceRef('git', BASELINE_COMMIT, 'phase23_baseline_commit'),
    ],
    side_effect_result: sideEffectResult(),
  };
  report.idempotency_key = runtimePromotionGateIdempotencyKey(report);
  report.gate_report_id = `runtime-promotion-gate-${stableHash(report.idempotency_key).slice(0, 12)}`;
  assertNoForbiddenOutput(report, asArray(contract.forbiddenOutputSubstrings));
  return report;
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

function phase23DependencyOk(report, contract = {}) {
  const dependency = report.phase_23_dependency || {};
  const expected = contract.expectedRuntimePromotionGateReportShape || {};
  return hasRequiredFields(dependency, expected.phase23DependencyRequiredFields || [])
    && Object.entries(expected.phase23DependencyRequiredValues || {}).every(([field, value]) => valuesMatch(dependency[field], value))
    && asArray(dependency.evidenceRefs).length > 0;
}

function prerequisiteGatesOk(report, contract = {}) {
  const gates = asArray(report.required_prerequisite_gates);
  const expected = contract.expectedRuntimePromotionGateReportShape || {};
  const requiredIds = asArray(expected.requiredPrerequisiteGateIds).length > 0
    ? expected.requiredPrerequisiteGateIds
    : DEFAULT_PREREQUISITE_GATE_IDS;
  const refs = expected.requiredPrerequisiteGateRefs || {};
  return gates.length === requiredIds.length
    && valuesMatch(gates.map((gate) => gate.gate_id), requiredIds)
    && gates.every((gate) => hasRequiredFields(gate, expected.requiredPrerequisiteGateFields || [])
      && gate.required_for_future_eligibility === true
      && gate.reference_only === true
      && gate.must_be_operator_visible === true
      && gate.blocks_if_missing === true
      && asArray(gate.evidenceRefs).length > 0
      && (!refs[gate.gate_id] || asArray(gate.phase_refs).includes(refs[gate.gate_id])));
}

function sideEffectGatesOk(report, contract = {}) {
  const gates = asArray(report.side_effect_gates);
  const expected = contract.expectedRuntimePromotionGateReportShape || {};
  const requiredIds = asArray(expected.requiredSideEffectGateIds).length > 0
    ? expected.requiredSideEffectGateIds
    : DEFAULT_SIDE_EFFECT_GATE_IDS;
  return gates.length === requiredIds.length
    && valuesMatch(gates.map((gate) => gate.gate_id), requiredIds)
    && gates.every((gate) => hasRequiredFields(gate, expected.sideEffectGateRequiredFields || [])
      && gate.must_remain_false_now === true
      && gate.failure_decision === 'blocked'
      && asArray(gate.evidenceRefs).length > 0)
    && sideEffectValuesOk(report.side_effect_result);
}

function proofBoundariesOk(report, contract = {}) {
  const proof = report.proof_boundaries || {};
  const expected = contract.expectedRuntimePromotionGateReportShape || {};
  return hasRequiredFields(proof, expected.proofBoundaryRequiredFields || [])
    && proof.socket_is_bridge_green_proof === false
    && proof.delivery_acceptance_is_model_processing_proof === false
    && proof.server_can_execute_local_arms === false
    && proof.builder_direct_server_target_allowed === false
    && proof.oracle_direct_server_target_allowed === false
    && proof.runtime_gate_is_runtime_proof === false
    && asArray(proof.evidenceRefs).length > 0;
}

function replaySafetyOk(report, contract = {}) {
  const replay = report.replay_safety_gates || {};
  const expected = contract.expectedRuntimePromotionGateReportShape || {};
  return hasRequiredFields(replay, expected.replaySafetyGateRequiredFields || [])
    && replay.phase_22_oracle_78_79_80_closure_required === true
    && replay.idempotency_gate === 'required'
    && replay.replay_gate === 'required'
    && replay.tombstone_gate === 'required'
    && replay.watermark_gate === 'required'
    && replay.expiry_gate === 'required'
    && replay.same_sequence_decision_binding_required === true
    && replay.recomputed_idempotency_regressions_required === true
    && asArray(replay.evidenceRefs).length > 0;
}

function environmentConfigOk(report, contract = {}) {
  const gates = asArray(report.environment_config_gates);
  const expected = contract.expectedRuntimePromotionGateReportShape || {};
  const requiredIds = asArray(expected.requiredEnvironmentConfigGateIds).length > 0
    ? expected.requiredEnvironmentConfigGateIds
    : DEFAULT_ENVIRONMENT_GATE_IDS;
  return gates.length === requiredIds.length
    && valuesMatch(gates.map((gate) => gate.gate_id), requiredIds)
    && gates.every((gate) => hasRequiredFields(gate, expected.environmentConfigGateRequiredFields || [])
      && gate.future_only === true
      && gate.reference_only === true
      && gate.raw_secret_allowed === false
      && gate.raw_path_allowed === false
      && gate.blocks_eligibility_if_missing === true
      && asArray(gate.evidenceRefs).length > 0);
}

function promotionDecisionOk(report, contract = {}) {
  const decision = report.operator_promotion_decision || {};
  const expected = contract.expectedRuntimePromotionGateReportShape || {};
  const allowed = asArray(expected.allowedPromotionDecisions).length > 0 ? expected.allowedPromotionDecisions : ALLOWED_PROMOTION_DECISIONS;
  const allowedRisk = asArray(expected.allowedPromotionRiskTiers).length > 0 ? expected.allowedPromotionRiskTiers : ALLOWED_PROMOTION_RISK_TIERS;
  const eligible = decision.decision === 'eligible_for_future_runtime_slice';
  const prereqOk = allPrerequisitesSatisfied(report.required_prerequisite_gates);
  const envOk = allEnvironmentGatesSatisfied(report.environment_config_gates);
  return hasRequiredFields(decision, expected.operatorPromotionDecisionRequiredFields || [])
    && allowed.includes(decision.decision)
    && valuesMatch(decision.allowed_decisions, allowed)
    && decision.default_decision === 'remain_validation_only'
    && allowedRisk.includes(decision.risk_tier)
    && decision.operator_visible === true
    && decision.runtime_started === false
    && decision.eligible_decision_is_authorization === false
    && asArray(decision.evidenceRefs).length > 0
    && (!eligible || (prereqOk && envOk && sideEffectValuesOk(report.side_effect_result) && proofBoundariesOk(report, contract) && replaySafetyOk(report, contract)));
}

function unsafeTierOk(report, contract = {}) {
  const allowedRisk = asArray(contract.expectedRuntimePromotionGateReportShape?.allowedPromotionRiskTiers).length > 0
    ? contract.expectedRuntimePromotionGateReportShape.allowedPromotionRiskTiers
    : ALLOWED_PROMOTION_RISK_TIERS;
  const decision = report.operator_promotion_decision || {};
  const blockedActionClasses = asArray(report.future_runtime_slice_limits?.blocked_action_classes);
  const requestedActionClasses = asArray(decision.requested_action_classes);
  const forbiddenRequested = requestedActionClasses.some((item) => /tier2|tier3|tier4|customer|deploy|trade|financial|local_execution/i.test(String(item)));
  return allowedRisk.includes(decision.risk_tier)
    && blockedActionClasses.some((item) => String(item).includes('customer'))
    && blockedActionClasses.some((item) => String(item).includes('deployment'))
    && blockedActionClasses.some((item) => String(item).includes('local_execution'))
    && !forbiddenRequested;
}

function killSwitchRollbackAuditOk(report) {
  const prereqIds = asArray(report.required_prerequisite_gates).map((gate) => gate.gate_id);
  const envIds = asArray(report.environment_config_gates).map((gate) => gate.gate_id);
  return prereqIds.includes('operator-kill-switch')
    && prereqIds.includes('dry-run-fallback')
    && envIds.includes('rollback-disable-plan-ref')
    && envIds.includes('telemetry-audit-plan-ref');
}

function tamperCoverageOk(report, contract = {}) {
  const requiredIds = asArray(contract.tamperCases).map((item) => item.id);
  const coverage = asArray(report.tamper_case_coverage);
  return requiredIds.length > 0
    && requiredIds.every((id) => coverage.some((item) => item.tamper_case_id === id && item.covered === true && asArray(item.evidenceRefs).length > 0));
}

function blockerSummaryOk(report, contract = {}) {
  const required = asArray(contract.expectedRuntimePromotionGateReportShape?.blockerSummaryRequiredIds).length > 0
    ? contract.expectedRuntimePromotionGateReportShape.blockerSummaryRequiredIds
    : DEFAULT_BLOCKER_IDS;
  const blockers = asArray(report.blocker_summary);
  return required.every((id) => blockers.some((blocker) => blocker.blocker_id === id
    && blocker.status
    && blocker.blocked_because
    && blocker.safe_next_action
    && asArray(blocker.evidenceRefs).length > 0));
}

function nextSafeActionsOk(report, contract = {}) {
  const required = asArray(contract.expectedRuntimePromotionGateReportShape?.nextSafeActionRequiredIds).length > 0
    ? contract.expectedRuntimePromotionGateReportShape.nextSafeActionRequiredIds
    : DEFAULT_NEXT_SAFE_ACTION_IDS;
  const actions = asArray(report.next_safe_actions);
  return required.every((id) => actions.some((action) => action.action_id === id))
    && actions.every((action) => action.allowed === true
      && ALLOWED_PROMOTION_RISK_TIERS.includes(action.risk_tier)
      && action.why_safe
      && asArray(action.blocked_side_effects).length > 0
      && asArray(action.evidenceRefs).length > 0);
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
      throw new Error(`runtime_promotion_gate_forbidden_substring:${forbidden}`);
    }
  }
}

function validateGateReport(report = {}, contract = {}) {
  const checks = [];
  const errors = [];
  const resultById = {};
  const add = (id, ok, detail = null, extra = {}) => {
    const result = resultObject(ok, detail, { id, ...extra });
    checks.push(result);
    resultById[id] = result;
    if (!ok && detail) errors.push(detail);
  };
  const expected = contract.expectedRuntimePromotionGateReportShape || {};

  add('output-shape-complete',
    report.schema === RUNTIME_PROMOTION_GATE_REPORT_SCHEMA_VERSION
      && hasRequiredFields(report, expected.requiredFields || REQUIRED_REPORT_FIELDS),
    'Runtime promotion gate report shape is incomplete.');

  add('baseline-3ce041c-pinned',
    report.baseline_commit === BASELINE_COMMIT,
    'Baseline commit must stay pinned to 3ce041c.');

  add('phase23-current-through-22-required',
    phase23DependencyOk(report, contract),
    'Phase 23 dependency is missing or stale.');

  add('operator-decision-allowed-and-safe',
    promotionDecisionOk(report, contract),
    'Promotion decision is unsafe or outside the allowed enum.');

  add('future-runtime-prerequisites-complete',
    prerequisiteGatesOk(report, contract),
    'Future runtime prerequisite gates are incomplete.');

  add('side-effect-gates-all-false-now',
    sideEffectGatesOk(report, contract),
    'Side-effect gates or truth are unsafe.');

  add('proof-boundaries-preserved',
    proofBoundariesOk(report, contract),
    'Proof boundaries were overclaimed.');

  add('replay-idempotency-tombstone-watermark-expiry-gates-present',
    replaySafetyOk(report, contract),
    'Replay/idempotency/tombstone/watermark/expiry gates are missing.');

  add('environment-config-reference-only',
    environmentConfigOk(report, contract),
    'Environment/config gates are incomplete or not reference-only.');

  add('unsafe-tier-promotion-rejected',
    unsafeTierOk(report, contract),
    'Unsafe promotion tier or action class was allowed.');

  add('fake-proof-rejected',
    proofBoundariesOk(report, contract) && report.operator_promotion_decision?.runtime_started === false,
    'Fake bridge/model/runtime proof was accepted.');

  add('kill-switch-rollback-audit-required',
    killSwitchRollbackAuditOk(report),
    'Kill switch, dry-run, rollback/disable, or audit gates are missing.');

  add('tamper-coverage-complete',
    tamperCoverageOk(report, contract),
    'Tamper case coverage is incomplete.');

  add('blocker-summary-complete',
    blockerSummaryOk(report, contract),
    'Required blocker summary is incomplete.');

  add('next-safe-actions-complete',
    nextSafeActionsOk(report, contract),
    'Next safe actions are missing or unsafe.');

  add('side-effect-truth-all-safe',
    sideEffectValuesOk(report.side_effect_result),
    'Phase 24 side-effect truth is unsafe.');

  try {
    assertNoForbiddenOutput(report, asArray(contract.forbiddenOutputSubstrings));
    add('raw-private-secret-leakage-rejected', true, null);
  } catch (err) {
    add('raw-private-secret-leakage-rejected', false, err.message);
  }

  add('report-literal-values',
    literalValuesOk(report, expected.requiredLiteralValues || {}),
    'Runtime promotion gate literal values changed.');

  add('idempotency-sensitive-to-gates',
    report.idempotency_key === runtimePromotionGateIdempotencyKey(report),
    'Runtime promotion gate idempotency key is unstable.');

  return {
    ok: errors.length === 0,
    checks,
    errors,
    resultById,
  };
}

function buildValidationReport(gateReport, contract = {}, generatedAt = gateReport.generated_at) {
  const validation = validateGateReport(gateReport, contract);
  const failed = validation.checks.filter((check) => !check.ok);
  const checkResult = (id) => validation.resultById[id] || resultObject(false, `${id} missing`);
  const report = {
    schema: VALIDATION_REPORT_SCHEMA_VERSION,
    version: RUNTIME_PROMOTION_GATE_VERSION,
    report_id: `runtime-promotion-validation-${stableHash({
      gate_key: gateReport.idempotency_key,
      generatedAt,
    }).slice(0, 12)}`,
    generated_at: generatedAt,
    baseline_commit: BASELINE_COMMIT,
    decision: validation.ok ? 'accepted' : 'blocked',
    reasons: failed.map((check) => check.detail || check.id),
    promotion_decision_result: checkResult('operator-decision-allowed-and-safe'),
    phase_23_dependency_result: checkResult('phase23-current-through-22-required'),
    prerequisite_gate_result: checkResult('future-runtime-prerequisites-complete'),
    side_effect_gate_result: checkResult('side-effect-gates-all-false-now'),
    proof_boundary_result: checkResult('proof-boundaries-preserved'),
    replay_safety_result: checkResult('replay-idempotency-tombstone-watermark-expiry-gates-present'),
    environment_config_result: checkResult('environment-config-reference-only'),
    acceptance_checks: asArray(contract.acceptanceChecks).map((check) => ({
      id: check.id,
      ok: validation.ok,
      focus: check.focus,
    })),
    failed_checks: failed.map((check) => check.id),
    side_effect_result: sideEffectResult(),
    evidenceRefs: [
      evidenceRef('mira-core-runtime-promotion-gate', 'phase24-validation-report'),
    ],
  };
  assertNoForbiddenOutput(report, asArray(contract.forbiddenOutputSubstrings));
  return report;
}

function buildMiraCoreRuntimePromotionGate(options = {}) {
  const contract = options.contract || {};
  const gateReport = buildGateReport(options);
  const validation_report = buildValidationReport(gateReport, contract, gateReport.generated_at);
  const output = {
    runtime_promotion_gate_report: gateReport,
    validation_report,
  };
  assertNoForbiddenOutput(output, asArray(contract.forbiddenOutputSubstrings));
  return output;
}

function validateMiraCoreRuntimePromotionGateOutput(output = {}, contract = {}) {
  const checks = [];
  const errors = [];
  const add = (id, ok, detail = null) => {
    checks.push({ id, ok: ok === true, detail });
    if (!ok && detail) errors.push(detail);
  };
  const gateReport = output.runtime_promotion_gate_report || {};
  const validationReport = output.validation_report || {};
  const gateValidation = validateGateReport(gateReport, contract);

  add('output-shape-complete',
    hasRequiredFields(output, contract.expectedOutputShape?.requiredTopLevelFields || REQUIRED_OUTPUT_FIELDS)
      && gateReport.schema === RUNTIME_PROMOTION_GATE_REPORT_SCHEMA_VERSION
      && validationReport.schema === VALIDATION_REPORT_SCHEMA_VERSION
      && hasRequiredFields(gateReport, contract.expectedRuntimePromotionGateReportShape?.requiredFields || REQUIRED_REPORT_FIELDS)
      && hasRequiredFields(validationReport, contract.expectedValidationReportShape?.requiredFields || REQUIRED_VALIDATION_REPORT_FIELDS),
    'Runtime promotion gate output shape is incomplete.');

  for (const check of gateValidation.checks) add(check.id, check.ok, check.detail);

  add('validation-report-literal-values',
    literalValuesOk(validationReport, contract.expectedValidationReportShape?.requiredLiteralValues || {}),
    'Validation report literal values changed.');

  add('validation-report-side-effect-truth',
    sideEffectValuesOk(validationReport.side_effect_result),
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
  ALLOWED_PROMOTION_DECISIONS,
  BASELINE_COMMIT,
  DEFAULT_PREREQUISITE_GATE_IDS,
  DEFAULT_SIDE_EFFECT_GATE_IDS,
  DEFAULT_TAMPER_CASE_IDS,
  REQUIRED_OUTPUT_FIELDS,
  REQUIRED_REPORT_FIELDS,
  REQUIRED_SIDE_EFFECT_FIELDS,
  REQUIRED_VALIDATION_REPORT_FIELDS,
  RUNTIME_PROMOTION_GATE_REPORT_SCHEMA_VERSION,
  VALIDATION_REPORT_SCHEMA_VERSION,
  assertNoForbiddenOutput,
  buildMiraCoreRuntimePromotionGate,
  runtimePromotionGateIdempotencyKey,
  stableHash,
  validateMiraCoreRuntimePromotionGateOutput,
};
